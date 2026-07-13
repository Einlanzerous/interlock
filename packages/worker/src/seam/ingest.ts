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

/**
 * The change hash we last staged for each `source_id` of a (source, kind).
 *
 * The other half of the seam's resume state, for sources that publish a change
 * primitive instead of an ordering. A cursor answers "where was I in the walk";
 * this answers "what did I already see" — and for LegiScan, whose master list
 * hands over a `change_hash` for every bill in one query, the second question is
 * the only one worth asking. The fetcher reads it through a port so it still
 * touches no SQL; a Go ingester runs this same statement.
 *
 * `source_record` is append-only (one row per observation), so the latest row per
 * source_id wins. A bill is only "seen" once its staging row is committed, which
 * is what makes an interrupted poll re-detect exactly the work that never landed.
 */
export async function readChangeHashes(
  pool: Pool,
  source: Source,
  kind: string,
): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ source_id: string; change_hash: string }>(
    `select distinct on (source_id) source_id, change_hash
     from source_record
     where source = $1 and kind = $2 and change_hash is not null
     order by source_id, fetched_at desc, id desc`,
    [source, kind],
  )
  return new Map(rows.map((row) => [row.source_id, row.change_hash]))
}

/** Resume point for a source; null = never polled. */
export async function readCursor(pool: Pool, source: Source): Promise<string | null> {
  const { rows } = await pool.query<{ cursor: string }>(
    'select cursor from fetch_cursor where source = $1',
    [source],
  )
  return rows[0]?.cursor ?? null
}
