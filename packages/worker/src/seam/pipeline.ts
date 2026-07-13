import type { Pool, PoolClient } from 'pg'
import type { PgBoss } from 'pg-boss'
import { PROCESS_RECORD_QUEUE, processRecordJobSchema, type Source } from '@interlock/shared'
import { DEFAULT_SIMILARITY_THRESHOLD, matchBill, type MatchBillResult } from '@interlock/db'
import {
  normalizeBody,
  normalizeMatter,
  normalizePerson,
} from '../sources/chi_clerk/adapters'
import { normalizeBill } from '../sources/legiscan_il/adapters'

/** A staged row as the pipeline sees it. */
export interface StagedRecord {
  id: number
  source: Source
  sourceId: string
  kind: string
  payload: Record<string, unknown>
  changeHash: string | null
}

/**
 * The worker's processing chain, in dependency order: normalize → match → diff.
 * Normalize is live for both sources as of ITLK-6; match (sponsor → official, ITLK-7)
 * and diff (change detection → alerts, ITLK-8) are still stubs. The chain shape and the
 * queue feeding it are fixed by the seam, so those tickets slot in without touching it.
 */

/**
 * Route a staged record to its source+kind adapter. Unknown pairs are logged, not
 * thrown: a source that stages a kind we don't normalize yet shouldn't wedge the queue
 * with a permanently failing job.
 *
 * Returns the bill it touched, if any — that is what the matcher needs next.
 */
async function normalize(db: PoolClient, record: StagedRecord): Promise<string | null> {
  if (record.source === 'chi_clerk') {
    switch (record.kind) {
      case 'matter':
        return (await normalizeMatter(db, record.payload)).billId ?? null
      case 'person':
        await normalizePerson(db, record.payload)
        return null
      case 'body':
        await normalizeBody(db, record.payload)
        return null
    }
  }
  if (record.source === 'legiscan_il' && record.kind === 'bill') {
    return (await normalizeBill(db, record.payload)).billId ?? null
  }
  console.warn(
    `[pipeline] no adapter for ${record.source}/${record.kind} — source_record ${record.id} staged but not normalized`,
  )
  return null
}

/**
 * The real normalizer: one transaction per staged record, so a partial normalize can
 * never land. A throw rolls the record back and lets pg-boss retry it, then fail it
 * visibly in pgboss.job rather than dropping it.
 *
 * Matching runs **inside that same transaction**. A sponsorship row and the decision
 * about who it points at are one fact, and a crash between them would leave the model
 * in a state no re-poll would revisit: the bill's change_hash is already stored, so the
 * next poll short-circuits and the half-matched row sits there forever.
 */
export function makeNormalizer(
  pool: Pool,
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): (record: StagedRecord) => Promise<void> {
  return async (record: StagedRecord): Promise<void> => {
    const db = await pool.connect()
    try {
      await db.query('begin')
      const billId = await normalize(db, record)
      if (billId) await matchRecord(db, billId, threshold)
      await db.query('commit')
    } catch (err) {
      await db.query('rollback')
      throw err
    } finally {
      db.release()
    }
    await diffRecord(record)
  }
}

/**
 * ITLK-7: sponsor → official identity resolution.
 *
 * Runs on every bill, including one whose payload was unchanged and short-circuited
 * in the adapter. That is deliberate: matching depends on the state of the `official`
 * table, not on the bill. A sponsor queued for review last week becomes tier-1
 * matchable the moment ingest seeds the Official it was waiting for — and the bill it
 * sits on may never change again.
 *
 * The scoring itself lives in @interlock/db, shared with the review-queue API.
 */
export async function matchRecord(
  db: PoolClient,
  billId: string,
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): Promise<MatchBillResult> {
  return matchBill(db, billId, threshold)
}

/** ITLK-8: change detection → alerts. */
export async function diffRecord(_record: StagedRecord): Promise<void> {
  // Intentionally empty until ITLK-8.
}

/** Queue rows are worker-owned: created once at boot, never by fetchers. */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  const existing = await boss.getQueue(PROCESS_RECORD_QUEUE)
  if (!existing) await boss.createQueue(PROCESS_RECORD_QUEUE)
}

/**
 * Register the process_record consumer: validate the job JSON, load the staged row,
 * hand it to the pipeline. Throwing lets pg-boss retry and then fail the job —
 * visible in pgboss.job, never silently dropped.
 */
export async function registerPipeline(
  boss: PgBoss,
  pool: Pool,
  handler: (record: StagedRecord) => Promise<void> = makeNormalizer(pool),
): Promise<string> {
  return boss.work(PROCESS_RECORD_QUEUE, { pollingIntervalSeconds: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { sourceRecordId } = processRecordJobSchema.parse(job.data)
      const { rows } = await pool.query(
        `select id, source, source_id, kind, payload, change_hash
         from source_record where id = $1`,
        [sourceRecordId],
      )
      const row = rows[0]
      if (!row) throw new Error(`process_record job for missing source_record ${sourceRecordId}`)
      await handler({
        id: Number(row.id),
        source: row.source,
        sourceId: row.source_id,
        kind: row.kind,
        payload: row.payload,
        changeHash: row.change_hash,
      })
    }
  })
}
