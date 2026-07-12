import type { Pool } from 'pg'
import type { PgBoss } from 'pg-boss'
import { PROCESS_RECORD_QUEUE, processRecordJobSchema, type Source } from '@interlock/shared'

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
 * Pipeline stubs — the worker's processing chain in dependency order. Real
 * implementations replace these bodies: normalize in ITLK-5/6 (per-source
 * adapters → canonical tables), match in ITLK-7 (sponsor → official), diff in
 * ITLK-8 (change detection → alerts). The chain shape and the queue feeding
 * it are fixed here so those tickets slot in without touching the seam.
 */
export async function normalizeRecord(record: StagedRecord): Promise<void> {
  console.log(
    `[pipeline] normalize stub: ${record.source}/${record.kind}/${record.sourceId} (source_record ${record.id})`,
  )
  await matchRecord(record)
}

export async function matchRecord(record: StagedRecord): Promise<void> {
  console.log(`[pipeline] match stub: source_record ${record.id}`)
  await diffRecord(record)
}

export async function diffRecord(record: StagedRecord): Promise<void> {
  console.log(`[pipeline] diff stub: source_record ${record.id}`)
}

/** Queue rows are worker-owned: created once at boot, never by fetchers. */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  const existing = await boss.getQueue(PROCESS_RECORD_QUEUE)
  if (!existing) await boss.createQueue(PROCESS_RECORD_QUEUE)
}

/**
 * Register the process_record consumer: validate the job JSON, load the
 * staged row, hand it to the pipeline. Throwing lets pg-boss retry and then
 * fail the job — visible in pgboss.job, never silently dropped.
 */
export async function registerPipeline(
  boss: PgBoss,
  pool: Pool,
  handler: (record: StagedRecord) => Promise<void> = normalizeRecord,
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
