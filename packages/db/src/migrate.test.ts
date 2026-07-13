import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { migrate, MIGRATIONS_DIR } from './migrate'

/**
 * Integration tests for ITLK-3's acceptance criteria. They need a real
 * Postgres 16 — set DATABASE_URL (any superuser-ish role that can CREATE
 * DATABASE); each run builds and drops a throwaway database so the
 * "empty Postgres" criterion is tested literally. CI provides a service
 * container; locally, `docker compose up db` + .env does it.
 */

const adminUrl = process.env.DATABASE_URL
if (!adminUrl) {
  console.warn('[db test] DATABASE_URL not set — skipping migration integration tests')
}

const TEST_DB = `interlock_test_${randomUUID().slice(0, 8)}`

let adminPool: Pool
let pool: Pool

describe.skipIf(!adminUrl)('migrate', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl, max: 1 })
    await adminPool.query(`create database ${TEST_DB}`)
    const testUrl = new URL(adminUrl!)
    testUrl.pathname = `/${TEST_DB}`
    pool = new Pool({ connectionString: testUrl.toString(), max: 2 })
  })

  afterAll(async () => {
    await pool?.end()
    await adminPool?.query(`drop database if exists ${TEST_DB} with (force)`)
    await adminPool?.end()
  })

  test('applies every migration on an empty database; second run is a no-op', async () => {
    // Read the directory rather than freezing a list here: the claim worth testing is
    // "every migration on disk ran, in order", not "there are exactly N of them".
    const onDisk = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()

    const first = await migrate(pool)
    expect(first).toEqual(onDisk)

    const second = await migrate(pool)
    expect(second).toEqual([])

    // The table list, by contrast, IS worth freezing — it is the schema the rest of the
    // codebase is written against, so a migration that adds or drops a table should have
    // to say so right here.
    const { rows } = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by table_name`,
    )
    expect(rows.map((r) => r.table_name)).toEqual([
      'alert',
      'api_budget',
      'bill',
      'bill_action',
      'committee',
      'fetch_cursor',
      'letter',
      'letter_bill',
      'letter_official',
      'membership',
      'official',
      'schema_migrations',
      'source_record',
      'sponsorship',
      'tracked_bill',
    ])

    const ext = await pool.query(`select 1 from pg_extension where extname = 'pg_trgm'`)
    expect(ext.rowCount).toBe(1)

    const boss = await pool.query(
      `select 1 from information_schema.schemata where schema_name = 'pgboss'`,
    )
    expect(boss.rowCount).toBe(1)

    const gin = await pool.query(
      `select 1 from pg_indexes where tablename = 'bill' and indexname = 'bill_search_tsv_idx'`,
    )
    expect(gin.rowCount).toBe(1)
  })

  test('seeded bill is found via search_tsv on a title word', async () => {
    await pool.query(
      `insert into bill (source, source_bill_id, identifier, jurisdiction, title, summary, raw)
       values ('chi_clerk', '7EC1A9AB-7C75-F111-AB0C-001DD80EDD69', 'O2026-0001', 'chicago_council',
               'Zoning reclassification of parcels near Western Ave',
               'Amends the zoning map for transit-oriented development', '{}')`,
    )

    const hit = await pool.query(
      `select identifier from bill
       where search_tsv @@ websearch_to_tsquery('english', 'zoning')`,
    )
    expect(hit.rows).toEqual([{ identifier: 'O2026-0001' }])

    const miss = await pool.query(
      `select 1 from bill where search_tsv @@ websearch_to_tsquery('english', 'stadium')`,
    )
    expect(miss.rowCount).toBe(0)
  })

  test('unmatched sponsorship inserts with null official_id + confidence (review queue)', async () => {
    const {
      rows: [bill],
    } = await pool.query<{ id: string }>(
      `insert into bill (source, source_bill_id, identifier, jurisdiction, title, raw)
       values ('legiscan_il', '99001', 'HB1234', 'il_ga', 'An act concerning transit funding', '{}')
       returning id`,
    )

    const inserted = await pool.query(
      `insert into sponsorship (bill_id, official_id, sponsor_name, sponsor_type, match_method, match_confidence)
       values ($1, null, 'Rep. J. Q. Ambiguous', 'co', 'name_similarity', 0.42)
       returning id`,
      [bill!.id],
    )
    expect(inserted.rowCount).toBe(1)

    // Re-poll of the same unmatched sponsor stays idempotent...
    await expect(
      pool.query(
        `insert into sponsorship (bill_id, official_id, sponsor_name)
         values ($1, null, 'Rep. J. Q. Ambiguous')`,
        [bill!.id],
      ),
    ).rejects.toThrow(/sponsorship_unmatched_uniq/)

    // ...and a confidence outside [0, 1] is rejected.
    await expect(
      pool.query(
        `insert into sponsorship (bill_id, official_id, sponsor_name, match_confidence)
         values ($1, null, 'Rep. Someone Else', 1.5)`,
        [bill!.id],
      ),
    ).rejects.toThrow(/sponsorship_confidence_range/)
  })

  test('manual federal contact: null source_person_ids + us_rep role', async () => {
    const inserted = await pool.query(
      `insert into official (source_person_ids, full_name, role, relationship_notes)
       values (null, 'Rep. Example Person', 'us_rep', 'met at town hall')
       returning id`,
    )
    expect(inserted.rowCount).toBe(1)
  })

  test('updated_at bumps on update', async () => {
    const {
      rows: [before],
    } = await pool.query<{ id: string; updated_at: Date }>(
      `select id, updated_at from bill where identifier = 'HB1234'`,
    )

    // now() is transaction-scoped, so a separate statement is a later timestamp.
    const {
      rows: [after],
    } = await pool.query<{ updated_at: Date }>(
      `update bill set title = title || ' (amended)' where id = $1 returning updated_at`,
      [before!.id],
    )
    expect(after!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime())
  })
})
