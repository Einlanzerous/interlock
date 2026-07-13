import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { migrate } from '@interlock/db'
import { normalizeBill } from './adapters'

/**
 * ITLK-6 adapter acceptance, against a real Postgres (throwaway DB per run, same
 * pattern as the eLMS adapter tests). The three payloads are verbatim captures of live
 * 104th GA bills, chosen because they are the cases the field map can actually get
 * wrong:
 *
 *   HB0022  enacted — "Public Act . . . 104-0162", progress event 8
 *   HR0001  adopted resolution — the SAME status int (4), no event 8
 *   HB0111  item/reduction veto, with roll-call summaries attached
 *   HB0001  sitting in Rules — status 1 refined to `referred`, and the only one of the
 *           four with a pending committee
 */

const adminUrl = process.env.DATABASE_URL
if (!adminUrl) {
  console.warn('[legiscan_il test] DATABASE_URL not set — skipping adapter integration tests')
}

const TEST_DB = `interlock_ls_${randomUUID().slice(0, 8)}`

let adminPool: Pool
let pool: Pool
let db: PoolClient

function fixture(name: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(import.meta.dir, '__fixtures__', name), 'utf8'))
  return raw.bill as Record<string, unknown>
}

const ENACTED = fixture('bill-enacted.json')
const RESOLUTION = fixture('bill-resolution.json')
const VETOED = fixture('bill-vetoed.json')
const IN_COMMITTEE = fixture('bill-in-committee.json')

const count = async (table: string): Promise<number> => {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)
  return rows[0]!.n
}

describe.skipIf(!adminUrl)('legiscan_il adapters', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl, max: 1 })
    await adminPool.query(`create database ${TEST_DB}`)
    const testUrl = new URL(adminUrl!)
    testUrl.pathname = `/${TEST_DB}`
    pool = new Pool({ connectionString: testUrl.toString(), max: 2 })
    await migrate(pool)
    db = await pool.connect()
  })

  afterAll(async () => {
    db?.release()
    await pool?.end()
    await adminPool?.query(`drop database if exists ${TEST_DB} with (force)`)
    await adminPool?.end()
  })

  afterEach(async () => {
    await db.query(
      'truncate bill, bill_action, sponsorship, official, committee, membership restart identity cascade',
    )
  })

  test('a real enacted bill becomes a canonical bill with history, sponsors and committee', async () => {
    const { billId } = await normalizeBill(db, ENACTED)

    const { rows } = await db.query(
      `select identifier, title, summary, bill_type, status, session, jurisdiction,
              introduced_date, last_action_text, last_action_date, change_hash,
              source_url, full_text_url, raw is not null as has_raw
       from bill where id = $1`,
      [billId],
    )
    const bill = rows[0]!

    expect(bill.identifier).toBe('HB0022')
    expect(bill.jurisdiction).toBe('il_ga')
    expect(bill.session).toBe('104th General Assembly')
    expect(bill.bill_type).toBe('bill')
    // The headline claim: status 4 + progress event 8 = law, not merely "passed".
    expect(bill.status).toBe('enacted')
    expect(bill.last_action_text).toContain('Public Act')
    expect(bill.change_hash).toBe(ENACTED.change_hash)
    expect(bill.summary).toBeTruthy() // description → summary, which feeds FTS
    expect(bill.has_raw).toBe(true)
    // The ILGA page, not legiscan.com — the authoritative record.
    expect(bill.source_url).toContain('ilga.gov')
    expect(bill.full_text_url).toContain('ilga.gov')

    const actions = await db.query<{ classification: string; description: string }>(
      `select classification, description from bill_action where bill_id = $1
       order by action_date, sequence`,
      [billId],
    )
    expect(actions.rows.length).toBeGreaterThan(5)
    // Whatever else it found, it found the law being signed.
    expect(actions.rows.some((a) => a.classification === 'signed')).toBe(true)
    expect(actions.rows.some((a) => a.classification === 'passage')).toBe(true)

    const sponsors = await db.query<{
      sponsor_name: string
      sponsor_type: string
      official_id: string | null
      source_person_id: string
    }>(
      `select sponsor_name, sponsor_type, official_id, source_person_id
       from sponsorship where bill_id = $1 order by sequence`,
      [billId],
    )
    expect(sponsors.rows.length).toBeGreaterThan(0)
    expect(sponsors.rows[0]!.sponsor_type).toBe('primary')
    // Ingest never guesses an identity — the link is ITLK-7's to make.
    expect(sponsors.rows.every((s) => s.official_id === null)).toBe(true)
    // ...but it hands ITLK-7 the exact key to make it with.
    expect(sponsors.rows.every((s) => /^\d+$/.test(s.source_person_id))).toBe(true)

    // An enacted bill has no *pending* committee, and LegiScan says so by sending
    // `committee: []` — an empty array where the object goes. Writing a committee row
    // here would invent one.
    expect(await count('committee')).toBe(0)
  })

  test('a bill sitting in committee is `referred`, and its pending committee is recorded', async () => {
    const { billId } = await normalizeBill(db, IN_COMMITTEE)

    const { rows } = await db.query<{ status: string; identifier: string }>(
      `select status, identifier from bill where id = $1`,
      [billId],
    )
    expect(rows[0]!.identifier).toBe('HB0001')
    // status 1 alone would read as `introduced`; progress event 9 says it moved.
    expect(rows[0]!.status).toBe('referred')

    // The committee rides along on getBill, so it costs no extra query.
    const committees = await db.query<{ name: string; source: string; jurisdiction: string }>(
      `select name, source, jurisdiction from committee`,
    )
    expect(committees.rows).toHaveLength(1)
    expect(committees.rows[0]!).toMatchObject({
      name: 'Rules',
      source: 'legiscan_il',
      jurisdiction: 'il_ga',
    })
  })

  test('an adopted resolution is `passed`, not `enacted` — same status int as the Public Act', async () => {
    const { billId } = await normalizeBill(db, RESOLUTION)

    const { rows } = await db.query<{ status: string; bill_type: string; identifier: string }>(
      `select status, bill_type, identifier from bill where id = $1`,
      [billId],
    )
    expect(rows[0]!.identifier).toBe('HR0001')
    expect(rows[0]!.bill_type).toBe('resolution')
    expect(rows[0]!.status).toBe('passed')

    const actions = await db.query<{ classification: string }>(
      `select classification from bill_action where bill_id = $1`,
      [billId],
    )
    expect(actions.rows.some((a) => a.classification === 'passage')).toBe(true) // "Resolution Adopted"
  })

  test('a vetoed bill lands as `vetoed`, and its roll calls survive in raw', async () => {
    const { billId } = await normalizeBill(db, VETOED)

    const { rows } = await db.query<{ status: string; raw: Record<string, unknown> }>(
      `select status, raw from bill where id = $1`,
      [billId],
    )
    expect(rows[0]!.status).toBe('vetoed')

    // The canonical schema has no roll-call table, which is exactly why getRollCall is
    // never called — the summaries LegiScan already sent ride along for ITLK-8's differ.
    const votes = rows[0]!.raw.votes as unknown[]
    expect(votes.length).toBeGreaterThan(0)

    const actions = await db.query<{ classification: string }>(
      `select classification from bill_action where bill_id = $1`,
      [billId],
    )
    expect(actions.rows.some((a) => a.classification === 'veto')).toBe(true)
  })

  test('officials are seeded from the sponsor bios — no getPerson call needed', async () => {
    await normalizeBill(db, ENACTED)

    const { rows } = await db.query<{
      full_name: string
      role: string
      party: string
      district: string
      phone: string | null
      office_address: string | null
      source_person_ids: Record<string, string>
    }>(
      `select full_name, role, party, district, phone, office_address, source_person_ids
       from official order by full_name`,
    )
    expect(rows.length).toBeGreaterThan(0)

    const official = rows[0]!
    expect(['state_rep', 'state_sen']).toContain(official.role)
    expect(official.district).toMatch(/^[HS]D-\d+$/)
    expect(official.party).toBeTruthy()
    // Tier-1's lookup key, stored as text for both sources so the containment
    // query is one shape rather than two.
    expect(Object.keys(official.source_person_ids)).toEqual(['legiscan_il'])
    expect(typeof Object.values(official.source_person_ids)[0]).toBe('string')
  })

  test('re-normalizing an unchanged payload writes nothing at all', async () => {
    const first = await normalizeBill(db, ENACTED)
    expect(first.writes).toBeGreaterThan(0)

    const { rows: before } = await db.query<{ updated_at: Date }>(
      `select updated_at from bill where id = $1`,
      [first.billId],
    )

    const second = await normalizeBill(db, ENACTED)

    // The change_hash short-circuit: nothing was even looked at downstream.
    expect(second.unchanged).toBe(true)
    expect(second.writes).toBe(0)

    const { rows: after } = await db.query<{ updated_at: Date }>(
      `select updated_at from bill where id = $1`,
      [first.billId],
    )
    expect(after[0]!.updated_at).toEqual(before[0]!.updated_at)
  })

  test('a changed hash re-normalizes without duplicating the timeline', async () => {
    await normalizeBill(db, ENACTED)
    const actionsBefore = await count('bill_action')
    const sponsorsBefore = await count('sponsorship')

    // Same bill, new hash: LegiScan republished it. The content is unchanged, so the
    // history must be recognized as the history we already have.
    await normalizeBill(db, { ...ENACTED, change_hash: 'a-brand-new-hash' })

    expect(await count('bill')).toBe(1)
    expect(await count('bill_action')).toBe(actionsBefore)
    expect(await count('sponsorship')).toBe(sponsorsBefore)
  })

  test('a backfilled history row does not renumber — and so does not duplicate — the rest', async () => {
    await normalizeBill(db, ENACTED)
    const before = await count('bill_action')

    // LegiScan backfills history. An index-based source_action_id would shift every
    // row after the insertion and duplicate the entire timeline on the next poll.
    const history = [...(ENACTED.history as Array<Record<string, unknown>>)]
    history.splice(1, 0, {
      date: '2025-01-10',
      action: 'Backfilled row nobody saw the first time',
      chamber: 'H',
      chamber_id: 35,
      importance: 0,
    })
    await normalizeBill(db, { ...ENACTED, change_hash: 'hash-2', history })

    // Exactly one new row: the backfilled one.
    expect(await count('bill_action')).toBe(before + 1)
  })

  test('a bill whose history repeats an action verbatim on one day keeps both rows', async () => {
    const duplicated = {
      ...RESOLUTION,
      change_hash: 'dupes',
      history: [
        { date: '2025-01-08', action: 'Added Co-Sponsor Rep. Jane Doe', chamber: 'H', importance: 0 },
        { date: '2025-01-08', action: 'Added Co-Sponsor Rep. Jane Doe', chamber: 'H', importance: 0 },
      ],
    }

    const { billId } = await normalizeBill(db, duplicated)

    const { rows } = await db.query<{ source_action_id: string }>(
      `select source_action_id from bill_action where bill_id = $1 order by sequence`,
      [billId],
    )
    // Content-addressed ids collide by design; the occurrence counter separates them.
    expect(rows).toHaveLength(2)
    expect(rows[0]!.source_action_id).not.toBe(rows[1]!.source_action_id)
  })

  test('a history row with no date is skipped, not invented — action_date is NOT NULL', async () => {
    const { billId } = await normalizeBill(db, {
      ...RESOLUTION,
      change_hash: 'no-date',
      history: [
        { date: '', action: 'A row with no date', chamber: 'H' },
        { date: '2025-01-08', action: 'Resolution Adopted', chamber: 'H' },
      ],
    })

    const { rows } = await db.query(`select id from bill_action where bill_id = $1`, [billId])
    expect(rows).toHaveLength(1)
  })
})
