import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { linkCommittee } from './committees'
import { migrate } from './migrate'

/**
 * ITLK-11's bill → committee resolution, against a real Postgres.
 *
 * The test that justifies the design is `links a bill whose committee arrived after it did`:
 * everything else here could be done inside the adapter, and that one could not.
 */

const adminUrl = process.env.DATABASE_URL
if (!adminUrl) {
  console.warn('[committees test] DATABASE_URL not set — skipping')
}

const TEST_DB = `interlock_cmte_${randomUUID().slice(0, 8)}`

let adminPool: Pool
let pool: Pool

async function bill(
  source: 'chi_clerk' | 'legiscan_il',
  jurisdiction: 'chicago_council' | 'il_ga',
  sourceCommittee: string | null,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into bill (source, source_bill_id, identifier, jurisdiction, title, source_committee, raw)
     values ($1, $2, $2, $3, 'A bill', $4, '{}')
     returning id`,
    [source, randomUUID(), jurisdiction, sourceCommittee],
  )
  return rows[0]!.id
}

async function committee(
  source: 'chi_clerk' | 'legiscan_il',
  jurisdiction: 'chicago_council' | 'il_ga',
  name: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into committee (source, source_body_id, name, jurisdiction)
     values ($1, $2, $3, $4) returning id`,
    [source, randomUUID(), name, jurisdiction],
  )
  return rows[0]!.id
}

const committeeOf = async (billId: string): Promise<string | null> => {
  const { rows } = await pool.query<{ committee_id: string | null }>(
    `select committee_id from bill where id = $1`,
    [billId],
  )
  return rows[0]!.committee_id
}

describe.skipIf(!adminUrl)('linkCommittee', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl, max: 1 })
    await adminPool.query(`create database ${TEST_DB}`)
    const testUrl = new URL(adminUrl!)
    testUrl.pathname = `/${TEST_DB}`
    pool = new Pool({ connectionString: testUrl.toString(), max: 2 })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool?.end()
    await adminPool?.query(`drop database if exists ${TEST_DB} with (force)`)
    await adminPool?.end()
  })

  afterEach(async () => {
    await pool.query('truncate bill, committee restart identity cascade')
  })

  test('resolves the source’s committee name to a committee row', async () => {
    const cmte = await committee(
      'chi_clerk',
      'chicago_council',
      'Committee on Budget and Government Operations',
    )
    const b = await bill('chi_clerk', 'chicago_council', 'Committee on Budget and Government Operations')

    const result = await linkCommittee(pool, b)
    expect(result.committeeId).toBe(cmte)
    expect(result.changed).toBe(true)
    expect(await committeeOf(b)).toBe(cmte)
  })

  /**
   * The whole reason this is a re-runnable pipeline stage and not an adapter lookup.
   *
   * eLMS serves matters and bodies from different endpoints with no ordering guarantee, so a
   * matter routinely normalizes before the body defining its committee has ever been fetched.
   * If the name were resolved at ingest, this bill's committee_id would be null forever: its
   * `source_last_modified` watermark short-circuits the next poll, and the adapter never
   * looks at it again.
   */
  test('links a bill whose committee arrived after it did', async () => {
    const b = await bill('chi_clerk', 'chicago_council', 'Committee on Zoning')

    // First poll: the body hasn't been ingested. No committee to point at, and that's fine.
    expect((await linkCommittee(pool, b)).committeeId).toBeNull()
    expect(await committeeOf(b)).toBeNull()

    // The body lands on a later poll…
    const cmte = await committee('chi_clerk', 'chicago_council', 'Committee on Zoning')

    // …and the very next run of the stage links the bill, without the bill having changed.
    const result = await linkCommittee(pool, b)
    expect(result.committeeId).toBe(cmte)
    expect(result.changed).toBe(true)
    expect(await committeeOf(b)).toBe(cmte)
  })

  test('matches case-insensitively and ignores surrounding whitespace', async () => {
    const cmte = await committee('legiscan_il', 'il_ga', 'Rules')
    const b = await bill('legiscan_il', 'il_ga', '  rules  ')
    expect((await linkCommittee(pool, b)).committeeId).toBe(cmte)
  })

  /**
   * Committees are jurisdiction-scoped. Chicago and Springfield both have a "Rules"
   * committee, and they are not the same body — linking an IL bill to Chicago's would be a
   * silent, plausible, wrong answer, which is the only kind that matters.
   */
  test('never crosses a jurisdiction, even on an identical name', async () => {
    const chicagoRules = await committee('chi_clerk', 'chicago_council', 'Rules')
    const ilRules = await committee('legiscan_il', 'il_ga', 'Rules')

    const chiBill = await bill('chi_clerk', 'chicago_council', 'Rules')
    const ilBill = await bill('legiscan_il', 'il_ga', 'Rules')

    expect((await linkCommittee(pool, chiBill)).committeeId).toBe(chicagoRules)
    expect((await linkCommittee(pool, ilBill)).committeeId).toBe(ilRules)
  })

  test('a claim that matches nothing leaves the link null rather than guessing', async () => {
    await committee('chi_clerk', 'chicago_council', 'Committee on Finance')
    const b = await bill('chi_clerk', 'chicago_council', 'Committee on Something Else Entirely')

    expect((await linkCommittee(pool, b)).committeeId).toBeNull()
    expect(await committeeOf(b)).toBeNull()
  })

  test('a bill with no committee claim resolves to null and stays quiet', async () => {
    const b = await bill('legiscan_il', 'il_ga', null)
    const result = await linkCommittee(pool, b)
    expect(result.committeeId).toBeNull()
    expect(result.changed).toBe(false) // null → null is not a write
  })

  /** Re-polling an unchanged bill must stay a genuine no-op — no write, no updated_at bump. */
  test('is idempotent: re-running an already-linked bill changes nothing', async () => {
    await committee('legiscan_il', 'il_ga', 'Transportation')
    const b = await bill('legiscan_il', 'il_ga', 'Transportation')

    expect((await linkCommittee(pool, b)).changed).toBe(true)

    const { rows: before } = await pool.query<{ updated_at: Date }>(
      `select updated_at from bill where id = $1`,
      [b],
    )
    const again = await linkCommittee(pool, b)
    expect(again.changed).toBe(false)

    const { rows: after } = await pool.query<{ updated_at: Date }>(
      `select updated_at from bill where id = $1`,
      [b],
    )
    expect(after[0]!.updated_at).toEqual(before[0]!.updated_at)
  })

  /** A bill re-referred to a different committee follows the source. */
  test('a re-referral moves the link', async () => {
    await committee('chi_clerk', 'chicago_council', 'Committee on Finance')
    const zoning = await committee('chi_clerk', 'chicago_council', 'Committee on Zoning')
    const b = await bill('chi_clerk', 'chicago_council', 'Committee on Finance')

    await linkCommittee(pool, b)
    await pool.query(`update bill set source_committee = 'Committee on Zoning' where id = $1`, [b])

    expect((await linkCommittee(pool, b)).committeeId).toBe(zoning)
  })
})
