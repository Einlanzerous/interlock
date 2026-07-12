import type { Pool } from 'pg'
import {
  PROCESS_RECORD_QUEUE,
  sourceRecordInputSchema,
  type FetchPage,
  type Source,
} from '@interlock/shared'

/**
 * Commit one poll page atomically: source_record rows + their process_record
 * jobs + the cursor advance, all in a single transaction. This is THE seam
 * write path — a Go fetcher runs the same three statements (see
 * docs/fetcher-seam.md). A crash anywhere inside rolls back the whole page,
 * which is what keeps re-polling idempotent: nothing partial ever lands, and
 * the cursor never points past uncommitted work.
 */
export async function commitPage(pool: Pool, source: Source, page: FetchPage): Promise<void> {
  const records = page.records.map((r) => sourceRecordInputSchema.parse(r))
  if (records.length === 0 && page.nextCursor === null) return

  const client = await pool.connect()
  try {
    await client.query('begin')
    for (const record of records) {
      const {
        rows: [staged],
      } = await client.query<{ id: string }>(
        `insert into source_record (source, source_id, kind, payload, change_hash)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [source, record.sourceId, record.kind, JSON.stringify(record.payload), record.changeHash ?? null],
      )
      // Direct SQL, not the pg-boss API — the enqueue must join this
      // transaction, and the SQL form is the language-agnostic contract.
      await client.query(`insert into pgboss.job (name, data) values ($1, $2)`, [
        PROCESS_RECORD_QUEUE,
        JSON.stringify({ sourceRecordId: Number(staged!.id) }),
      ])
    }
    if (page.nextCursor !== null) {
      await client.query(
        `insert into fetch_cursor (source, cursor) values ($1, $2)
         on conflict (source) do update set cursor = excluded.cursor`,
        [source, page.nextCursor],
      )
    }
    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

/** Resume point for a source; null = never polled. */
export async function readCursor(pool: Pool, source: Source): Promise<string | null> {
  const { rows } = await pool.query<{ cursor: string }>(
    'select cursor from fetch_cursor where source = $1',
    [source],
  )
  return rows[0]?.cursor ?? null
}
