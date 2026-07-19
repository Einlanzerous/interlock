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

  /**
   * ITLK-21. An organization is a first-class contact: contact_type = 'org', no role, an
   * org_type instead, and — always — a null source_person_ids, which is what keeps ingest
   * and the sponsor matcher (both of which only ever find rows by source person id) from
   * ever touching it. The shape check is what forbids the mongrel rows a flag column invites.
   */
  test('organization contact: contact_type org + org_type, no role, invisible to ingest', async () => {
    const {
      rows: [org],
    } = await pool.query<{ id: string; contact_type: string; role: string | null }>(
      `insert into official (contact_type, full_name, org_type, email, department)
       values ('org', 'Chicago Metropolitan Agency for Planning', 'agency',
               'info@cmap.illinois.gov', 'Planning Division')
       returning id, contact_type, role`,
    )
    expect(org!.contact_type).toBe('org')
    expect(org!.role).toBeNull()

    // source_person_ids defaults to null, so the tier-1 matcher's lookup can never find it.
    const invisible = await pool.query(
      `select 1 from official
       where source_person_ids @> jsonb_build_object('legiscan', '1') and id = $1`,
      [org!.id],
    )
    expect(invisible.rowCount).toBe(0)
  })

  test('shape check: an org may not carry a role, a person must have one', async () => {
    // Org with a role — rejected.
    await expect(
      pool.query(
        `insert into official (contact_type, full_name, org_type, role)
         values ('org', 'Bad Org', 'media', 'alder')`,
      ),
    ).rejects.toThrow(/official_contact_shape/)

    // Org with no org_type — rejected.
    await expect(
      pool.query(
        `insert into official (contact_type, full_name) values ('org', 'Typeless Org')`,
      ),
    ).rejects.toThrow(/official_contact_shape/)

    // Person carrying an org_type — rejected.
    await expect(
      pool.query(
        `insert into official (contact_type, full_name, role, org_type)
         values ('person', 'Confused Person', 'alder', 'media')`,
      ),
    ).rejects.toThrow(/official_contact_shape/)
  })

  test('a staffer affiliates to an org via org_id; deleting the org orphans, not deletes', async () => {
    const {
      rows: [org],
    } = await pool.query<{ id: string }>(
      `insert into official (contact_type, full_name, org_type)
       values ('org', 'CDOT', 'agency') returning id`,
    )
    const {
      rows: [staffer],
    } = await pool.query<{ id: string }>(
      `insert into official (contact_type, full_name, role, org_id)
       values ('person', 'A Staffer at CDOT', 'other', $1) returning id`,
      [org!.id],
    )

    // An org may not point an affiliation at anything (org_id must stay null on an org)…
    await expect(
      pool.query(`update official set org_id = $2 where id = $1`, [org!.id, staffer!.id]),
    ).rejects.toThrow(/official_contact_shape/)

    // …and deleting the org sets the staffer's org_id back to null rather than cascading.
    await pool.query(`delete from official where id = $1`, [org!.id])
    const {
      rows: [after],
    } = await pool.query<{ org_id: string | null }>(
      `select org_id from official where id = $1`,
      [staffer!.id],
    )
    expect(after!.org_id).toBeNull()
  })

  /**
   * ITLK-21. The detail endpoint names a person's org in the same round trip via a self-join,
   * and lists an org's staff via org_id. Those two SQL shapes are new, so they're pinned here
   * against a real database rather than only type-checked.
   */
  test('org detail SQL: self-join names the affiliation, org_id lists the staff', async () => {
    const {
      rows: [org],
    } = await pool.query<{ id: string }>(
      `insert into official (contact_type, full_name, org_type, department)
       values ('org', 'CMAP', 'agency', 'Planning Division') returning id`,
    )
    await pool.query(
      `insert into official (contact_type, full_name, role, org_id)
       values ('person', 'Staffer One', 'other', $1), ('person', 'Staffer Two', 'other', $1)`,
      [org!.id],
    )

    // The person side: their affiliated org's name comes back on the same row (index [id].get).
    const person = await pool.query<{ full_name: string; org_name: string | null }>(
      `select o.full_name, org.full_name as org_name
       from official o left join official org on org.id = o.org_id
       where o.full_name = 'Staffer One'`,
    )
    expect(person.rows[0]!.org_name).toBe('CMAP')

    // The org side: its staff, active first then by name.
    const staff = await pool.query<{ full_name: string }>(
      `select full_name from official where org_id = $1 order by active desc, full_name`,
      [org!.id],
    )
    expect(staff.rows.map((r) => r.full_name)).toEqual(['Staffer One', 'Staffer Two'])

    // The roster's contact_type filter returns the org and excludes the people.
    const orgsOnly = await pool.query<{ full_name: string }>(
      `select full_name from official
       where ($1::contact_type is null or contact_type = $1) and full_name in ('CMAP','Staffer One')
       order by full_name`,
      ['org'],
    )
    expect(orgsOnly.rows.map((r) => r.full_name)).toEqual(['CMAP'])
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

  /**
   * ITLK-10. `letter_official`'s primary key is (letter_id, official_id, role), which means
   * one person can legitimately be BOTH `recipient` and `cc` on the same letter.
   *
   * That is the right model — it is a true fact about a letter — but it is a trap for any
   * read that joins the table and forgets to group: the official's correspondence tab
   * (ITLK-9) listed such a letter twice until it did. The shape is pinned here so the next
   * query written against this table is written against a known one.
   */
  test('one official can hold two roles on one letter — reads must group, not join', async () => {
    const {
      rows: [official],
    } = await pool.query<{ id: string }>(
      `insert into official (source_person_ids, full_name, role)
       values (null, 'Dual Role Person', 'alder') returning id`,
    )
    const {
      rows: [letter],
    } = await pool.query<{ id: string }>(
      `insert into letter (direction, channel, subject) values ('sent', 'email', 'Dual role')
       returning id`,
    )

    // Both inserts succeed: the role is part of the key.
    await pool.query(
      `insert into letter_official (letter_id, official_id, role) values ($1, $2, 'recipient')`,
      [letter!.id, official!.id],
    )
    await pool.query(
      `insert into letter_official (letter_id, official_id, role) values ($1, $2, 'cc')`,
      [letter!.id, official!.id],
    )

    // …so a naive join returns the letter twice for that one person.
    const naive = await pool.query(
      `select l.id from letter_official lo join letter l on l.id = lo.letter_id
       where lo.official_id = $1`,
      [official!.id],
    )
    expect(naive.rowCount).toBe(2)

    // The correspondence tab groups, and gets one letter carrying both roles.
    //
    // `lo.role::text` is load-bearing: node-postgres registers no array parser for a custom
    // enum, so `array_agg(lo.role)` returns the raw literal '{recipient,cc}' as a *string*
    // and any caller that treats it as string[] breaks. Casting inside the aggregate is what
    // makes it an array on this side of the wire.
    //
    // The order is the enum's, not the alphabet's: letter_official_role is declared
    // (recipient, sender, cc), so `order by lo.role` sorts recipient before cc.
    const grouped = await pool.query<{ id: string; roles: string[] }>(
      `select l.id, array_agg(lo.role::text order by lo.role) as roles
       from letter_official lo join letter l on l.id = lo.letter_id
       where lo.official_id = $1
       group by l.id`,
      [official!.id],
    )
    expect(grouped.rowCount).toBe(1)
    expect(grouped.rows[0]!.roles).toEqual(['recipient', 'cc'])

    // The same (letter, official, role) twice is still a duplicate, though.
    await expect(
      pool.query(
        `insert into letter_official (letter_id, official_id, role) values ($1, $2, 'cc')`,
        [letter!.id, official!.id],
      ),
    ).rejects.toThrow(/letter_official_pkey/)
  })

  /**
   * ITLK-10's delete leans on this: removing a mistaken draft must not leave an official's
   * correspondence tab pointing at a letter that no longer exists.
   */
  test('deleting a letter cascades its links to officials and bills', async () => {
    const {
      rows: [official],
    } = await pool.query<{ id: string }>(
      `insert into official (source_person_ids, full_name, role)
       values (null, 'Cascade Person', 'us_sen') returning id`,
    )
    const {
      rows: [bill],
    } = await pool.query<{ id: string }>(`select id from bill where identifier = 'HB1234'`)
    const {
      rows: [letter],
    } = await pool.query<{ id: string }>(
      `insert into letter (direction, channel, subject) values ('sent', 'mail', 'Cascade me')
       returning id`,
    )

    await pool.query(
      `insert into letter_official (letter_id, official_id, role) values ($1, $2, 'recipient')`,
      [letter!.id, official!.id],
    )
    await pool.query(`insert into letter_bill (letter_id, bill_id) values ($1, $2)`, [
      letter!.id,
      bill!.id,
    ])

    await pool.query(`delete from letter where id = $1`, [letter!.id])

    const links = await pool.query(
      `select 1 from letter_official where letter_id = $1
       union all
       select 1 from letter_bill where letter_id = $1`,
      [letter!.id],
    )
    expect(links.rowCount).toBe(0)

    // The official and the bill outlive the letter — only the link died.
    const survivors = await pool.query(
      `select 1 from official where id = $1 union all select 1 from bill where id = $2`,
      [official!.id, bill!.id],
    )
    expect(survivors.rowCount).toBe(2)
  })
})
