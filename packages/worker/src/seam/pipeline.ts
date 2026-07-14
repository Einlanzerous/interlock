import type { Pool, PoolClient } from 'pg'
import type { PgBoss } from 'pg-boss'
import { PROCESS_RECORD_QUEUE, processRecordJobSchema, type Source } from '@interlock/shared'
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  linkCommittee,
  matchBill,
  type MatchBillResult,
} from '@interlock/db'
import {
  normalizeBody,
  normalizeMatter,
  normalizePerson,
} from '../sources/chi_clerk/adapters'
import { normalizeBill } from '../sources/legiscan_il/adapters'
import { diffTrackedBill, snapshotTrackedBill, type FiredAlert, type TrackedBillContext } from '../alerts/differ'
import type { AlertSink } from '../alerts/deliver'

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
 * All three stages are live: normalize (ITLK-5/6), match (sponsor → official, ITLK-7),
 * diff (change detection → alerts, ITLK-8). The chain shape and the queue feeding it
 * are fixed by the seam.
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
 *
 * The differ (ITLK-8) brackets normalize inside the transaction too — snapshot before,
 * diff + alert writes after — for the same atomicity reason: the alert and the canonical
 * change it reports must land together or not at all, which is also what makes re-polls
 * duplicate-proof. Only channel fan-out (email) waits for the commit; `alertSink` is
 * best-effort and must not throw (see makeAlerter).
 */
export function makeNormalizer(
  pool: Pool,
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
  alertSink: AlertSink = async () => {},
): (record: StagedRecord) => Promise<void> {
  return async (record: StagedRecord): Promise<void> => {
    const db = await pool.connect()
    let fired: { ctx: TrackedBillContext; alerts: FiredAlert[] } | null = null
    try {
      await db.query('begin')
      const tracked = await snapshotTrackedBill(db, record.source, record.sourceId)
      const billId = await normalize(db, record)
      if (billId) {
        await matchRecord(db, billId, threshold)
        await linkRecord(db, billId)
      }
      if (tracked) {
        const alerts = await diffRecord(db, tracked)
        if (alerts.length > 0) fired = { ctx: tracked, alerts }
      }
      await db.query('commit')
    } catch (err) {
      await db.query('rollback')
      throw err
    } finally {
      db.release()
    }
    if (fired) await alertSink(fired.ctx, fired.alerts)
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

/**
 * ITLK-11: bill → committee resolution.
 *
 * Runs on every bill for exactly the reason the matcher does, one stage up: the answer
 * depends on the state of the `committee` table, not on the bill. A Chicago matter is
 * routinely normalized before the body that defines its committee has been fetched — resolve
 * the name inside the adapter and that bill's committee_id is null forever, because its
 * watermark short-circuits the next poll and the adapter never revisits it. Here, the link
 * appears on the first poll after the committee does.
 *
 * The scoring — such as it is — lives in @interlock/db, shared with the Bills API.
 */
export async function linkRecord(db: PoolClient, billId: string): Promise<void> {
  await linkCommittee(db, billId)
}

/**
 * ITLK-8: change detection → alerts. Compares the pre-normalize snapshot against
 * canonical state now, writes one alert row per change_type that moved. The real
 * logic lives in ../alerts/differ; this is the pipeline's named stage.
 */
export async function diffRecord(
  db: PoolClient,
  tracked: TrackedBillContext,
): Promise<FiredAlert[]> {
  return diffTrackedBill(db, tracked)
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
