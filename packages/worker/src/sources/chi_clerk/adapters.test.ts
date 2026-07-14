import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { migrate } from '@interlock/db'
import { normalizeBody, normalizeMatter, normalizePerson } from './adapters'

/**
 * ITLK-5 adapter acceptance, run against a real Postgres (throwaway DB per run, same
 * pattern as the seam tests). The payloads are verbatim captures from the live eLMS
 * API, so the field map is tested against what the Clerk actually serves — including
 * its blank strings and its misspelled `committeReferral`.
 */

const adminUrl = process.env.DATABASE_URL
if (!adminUrl) {
  console.warn('[chi_clerk test] DATABASE_URL not set — skipping adapter integration tests')
}

const TEST_DB = `interlock_chi_${randomUUID().slice(0, 8)}`

let adminPool: Pool
let pool: Pool
let db: PoolClient

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(import.meta.dir, '__fixtures__', name), 'utf8'))
}

const MATTER = fixture('matter-detail.json')
const PERSON = fixture('person.json')
const BODY = fixture('body.json')

/** Capture console.warn so the "unknown vocabulary warns" criterion is provable. */
function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '))
  }
  return fn()
    .then((result) => ({ result, warnings }))
    .finally(() => {
      console.warn = original
    })
}

const count = async (table: string): Promise<number> => {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)
  return rows[0]!.n
}

describe.skipIf(!adminUrl)('chi_clerk adapters', () => {
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

  // Each test starts from an empty canonical model.
  afterEach(async () => {
    await db.query(
      'truncate bill, bill_action, sponsorship, official, committee, membership restart identity cascade',
    )
  })

  test('a real matter becomes a bill with actions and sponsor rows', async () => {
    const { billId } = await normalizeMatter(db, MATTER)

    const { rows } = await db.query(
      `select identifier, title, bill_type, status, session, jurisdiction, introduced_date,
              last_action_text, last_action_date, source_last_modified, full_text_url, source_url,
              raw is not null as has_raw
       from bill where id = $1`,
      [billId],
    )
    const bill = rows[0]!
    expect(bill.identifier).toBe('SO2025-0019977')
    expect(bill.bill_type).toBe('Ordinance')
    expect(bill.jurisdiction).toBe('chicago_council')
    expect(bill.session).toBe('2025')
    // "5-Council Consideration" → out of committee, awaiting the Council vote.
    expect(bill.status).toBe('engrossed')
    expect(bill.introduced_date).toEqual(new Date('2025-09-25T00:00:00Z'))
    expect(bill.has_raw).toBe(true)
    // The Legislation attachment, not the first one blindly.
    expect(bill.full_text_url).toContain('.pdf')
    expect(bill.source_url).toContain(String(MATTER.matterId))
    // Latest action = same date as "Substituted" but a higher eLMS sort.
    expect(bill.last_action_text).toContain('recommended to Pass')

    const actions = await db.query(
      `select source_action_id, description, classification, actor, sequence
       from bill_action where bill_id = $1 order by sequence`,
      [billId],
    )
    expect(actions.rows).toHaveLength(3)
    expect(actions.rows.map((a) => a.classification)).toEqual(['referred', 'amendment', 'vote'])
    // actionText is blank on the Substituted row — description falls back to actionName
    // rather than violating NOT NULL or writing an empty string.
    expect(actions.rows.find((a) => a.classification === 'amendment')!.description).toBe(
      'Substituted',
    )

    const sponsors = await db.query(
      `select sponsor_name, sponsor_type, official_id from sponsorship where bill_id = $1
       order by sequence`,
      [billId],
    )
    expect(sponsors.rows).toHaveLength(5)
    // eLMS labels the lead "Sponsor" (it matches filingSponsorId); the rest are CoSponsor.
    expect(sponsors.rows[0]!.sponsor_name).toBe('Lopez, Raymond A.')
    expect(sponsors.rows[0]!.sponsor_type).toBe('primary')
    expect(sponsors.rows.slice(1).every((s) => s.sponsor_type === 'co')).toBe(true)
    // Identity resolution is ITLK-7's job — never guess it here.
    expect(sponsors.rows.every((s) => s.official_id === null)).toBe(true)
  })

  test('re-normalizing an unchanged matter writes nothing', async () => {
    const first = await normalizeMatter(db, MATTER)
    expect(first.writes).toBeGreaterThan(0)

    const before = await db.query<{ updated_at: Date }>(`select updated_at from bill where id = $1`, [
      first.billId,
    ])

    const second = await normalizeMatter(db, MATTER)
    expect(second.writes).toBe(0)
    expect(second.unchanged).toBe(true)

    // No churn anywhere: no duplicate history, no bumped updated_at.
    expect(await count('bill')).toBe(1)
    expect(await count('bill_action')).toBe(3)
    expect(await count('sponsorship')).toBe(5)
    const after = await db.query<{ updated_at: Date }>(`select updated_at from bill where id = $1`, [
      first.billId,
    ])
    expect(after.rows[0]!.updated_at).toEqual(before.rows[0]!.updated_at)
  })

  test('a republished matter updates in place and adds only the new action', async () => {
    const { billId } = await normalizeMatter(db, MATTER)

    const moved = {
      ...MATTER,
      lastPublicationDate: '2026-07-20T10:00:00+00:00',
      status: '90-Final',
      subStatus: 'Passed',
      actions: [
        ...(MATTER.actions as unknown[]),
        {
          historyId: 'NEW-ACTION-GUID',
          actionName: 'Passed',
          actionByName: 'City Council',
          actionText: 'The matter was Passed.',
          actionDate: '2026-07-15T05:00:00+00:00',
          sort: 100,
          votes: [],
        },
      ],
    }
    const result = await normalizeMatter(db, moved)
    expect(result.billId).toBe(billId!) // upserted, not duplicated
    expect(await count('bill')).toBe(1)

    const { rows } = await db.query(`select status, last_action_text from bill where id = $1`, [billId])
    expect(rows[0]!.status).toBe('passed') // 90-Final resolved through subStatus
    expect(rows[0]!.last_action_text).toBe('The matter was Passed.')

    // Existing history is deduped on (bill_id, source_action_id); only the new row lands.
    expect(await count('bill_action')).toBe(4)
    expect(await count('sponsorship')).toBe(5)
  })

  test('an unknown status still ingests, as unknown, with a warning', async () => {
    const { result, warnings } = await captureWarnings(() =>
      normalizeMatter(db, { ...MATTER, status: '7-Referred to the Bananas Committee' }),
    )
    const { rows } = await db.query(`select status from bill where id = $1`, [result.billId])
    expect(rows[0]!.status).toBe('unknown') // the bill still lands
    expect(warnings.some((w) => w.includes('unmapped status'))).toBe(true)
  })

  test('a 90-Final matter with an unrecognized outcome is unknown, not silently "passed"', async () => {
    const { result, warnings } = await captureWarnings(() =>
      normalizeMatter(db, { ...MATTER, status: '90-Final', subStatus: 'Reconsidered Sideways' }),
    )
    const { rows } = await db.query(`select status from bill where id = $1`, [result.billId])
    expect(rows[0]!.status).toBe('unknown')
    expect(warnings.some((w) => w.includes('90-Final subStatus'))).toBe(true)
  })

  test('committeReferral is synthesized into an action only when eLMS records none', async () => {
    // The real payload already has a "Referred" action → nothing is synthesized.
    const withReferral = await normalizeMatter(db, MATTER)
    const existing = await db.query(
      `select count(*)::int as n from bill_action
       where bill_id = $1 and source_action_id = 'chi_clerk:committee-referral'`,
      [withReferral.billId],
    )
    expect(existing.rows[0]!.n).toBe(0)
    await db.query('truncate bill cascade')

    // Strip the Referred action: the referral must not be lost.
    const noReferralAction = {
      ...MATTER,
      actions: (MATTER.actions as Array<Record<string, unknown>>).filter(
        (a) => a.actionName !== 'Referred',
      ),
    }
    const synthesized = await normalizeMatter(db, noReferralAction)
    const { rows } = await db.query(
      `select description, classification, actor, sequence from bill_action
       where bill_id = $1 and source_action_id = 'chi_clerk:committee-referral'`,
      [synthesized.billId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.classification).toBe('referred')
    expect(rows[0]!.actor).toBe('Committee on Budget and Government Operations')
    expect(rows[0]!.description).toBe('Referred to Committee on Budget and Government Operations')

    // ...and it is idempotent (stable source_action_id, not a fresh row each poll).
    await normalizeMatter(db, { ...noReferralAction, lastPublicationDate: '2026-07-21T00:00:00Z' })
    const again = await db.query(
      `select count(*)::int as n from bill_action
       where bill_id = $1 and source_action_id = 'chi_clerk:committee-referral'`,
      [synthesized.billId],
    )
    expect(again.rows[0]!.n).toBe(1)
  })

  test('a person becomes an official keyed on the eLMS personId', async () => {
    const { officialId } = await normalizePerson(db, PERSON)
    const { rows } = await db.query(
      `select full_name, role, ward, email, phone, office_address, active, source_person_ids
       from official where id = $1`,
      [officialId],
    )
    const official = rows[0]!
    expect(official.full_name).toBe('Zalewski, Michael R.') // trailing space trimmed
    expect(official.role).toBe('alder')
    expect(official.ward).toBe(23)
    expect(official.email).toBe('Ward23@cityofchicago.org')
    expect(official.active).toBe(false) // isActive: false
    expect(official.office_address).toContain('6247 South Archer Avenue')
    // The tier-1 match key ITLK-7 will resolve sponsors against.
    expect(official.source_person_ids).toEqual({ chi_clerk: PERSON.personId })

    // Re-normalizing the same person writes nothing.
    const again = await normalizePerson(db, PERSON)
    expect(again.writes).toBe(0)
    expect(await count('official')).toBe(1)
  })

  test('a body becomes a committee and seeds the officials it links', async () => {
    const { committeeId } = await normalizeBody(db, BODY)
    const { rows } = await db.query(
      `select name, classification, jurisdiction from committee where id = $1`,
      [committeeId],
    )
    expect(rows[0]!.name).toBe('Office of the Mayor')
    expect(rows[0]!.classification).toBe('Executive Office')
    expect(rows[0]!.jurisdiction).toBe('chicago_council')

    // members[] carries the /person shape, so the body seeds its own officials rather
    // than depending on the person phase having been normalized first (pg-boss may
    // run those jobs in either order).
    expect(await count('official')).toBe(4)
    expect(await count('membership')).toBe(4)

    const mayor = await db.query(
      `select o.full_name, o.role, o.active, m.role as membership_role
       from official o join membership m on m.official_id = o.id
       where o.full_name = 'Johnson, Brandon'`,
    )
    expect(mayor.rows[0]!.role).toBe('mayor') // ward is "Mayor", not a number
    expect(mayor.rows[0]!.active).toBe(true)
    expect(mayor.rows[0]!.membership_role).toBe('Mayor')

    // Idempotent: no duplicate committees, officials, or memberships.
    const again = await normalizeBody(db, BODY)
    expect(again.writes).toBe(0)
    expect(await count('committee')).toBe(1)
    expect(await count('official')).toBe(4)
    expect(await count('membership')).toBe(4)
  })

  test('the person and body adapters converge on one official for the same personId', async () => {
    await normalizeBody(db, BODY)
    const seededByBody = await count('official')

    // Brandon Johnson, as /person would serve him.
    const members = BODY.members as Array<Record<string, unknown>>
    const johnson = members.find((m) => m.displayName === 'Johnson, Brandon')!
    await normalizePerson(db, { ...johnson, ward: 'Mayor' })

    // Same personId → same official row, not a second one.
    expect(await count('official')).toBe(seededByBody)
  })

  /**
   * ITLK-9. The CRM's whole value is the column ingest must never touch: the organizer's
   * notes on a person. That guarantee is structural — no ingest statement names
   * `relationship_notes` — but "structural" is only true until someone adds a column to an
   * upsert, so it is pinned here rather than left to be rediscovered.
   *
   * `party` and `district` ride along for the same reason: the eLMS person payload carries
   * neither, so they too are the organizer's on a sourced official, and the CRM offers them
   * as editable on that basis.
   */
  test('re-ingest refreshes contact fields but never the organizer’s columns', async () => {
    const { officialId } = await normalizePerson(db, PERSON)

    await db.query(
      `update official
         set relationship_notes = $2, party = $3, district = $4
       where id = $1`,
      [officialId, 'Chief of staff is the one who answers.', 'D', 'sw-side'],
    )

    // The Clerk republishes the person with new contact details and a reactivated seat.
    const republished = {
      ...PERSON,
      email: 'ward23.new@cityofchicago.org',
      phone: '(773) 582-9999',
      isActive: true,
    }
    const again = await normalizePerson(db, republished)
    expect(again.writes).toBe(1) // it really did rewrite the row
    expect(await count('official')).toBe(1) // and did not fork a second one

    const { rows } = await db.query(
      `select email, phone, active, relationship_notes, party, district
       from official where id = $1`,
      [officialId],
    )
    const official = rows[0]!

    // Ingest owns these, and refreshed them.
    expect(official.email).toBe('ward23.new@cityofchicago.org')
    expect(official.phone).toBe('(773) 582-9999')
    expect(official.active).toBe(true)

    // The organizer owns these, and re-ingest left them alone.
    expect(official.relationship_notes).toBe('Chief of staff is the one who answers.')
    expect(official.party).toBe('D')
    expect(official.district).toBe('sw-side')
  })

  /**
   * ITLK-9's federal variance: a hand-added contact has no `source_person_ids`, so an
   * ingest poll has no key to find it by and cannot touch it. The Clerk publishing an
   * unrelated alder must not so much as bump its updated_at.
   */
  test('an ingest poll never touches a manually-added official', async () => {
    const { rows: created } = await db.query<{ id: string; updated_at: Date }>(
      `insert into official (source_person_ids, full_name, role, district, email, relationship_notes)
       values (null, 'Tammy Duckworth', 'us_sen', 'IL', 'senator@duckworth.senate.gov', 'Prefers the web form.')
       returning id, updated_at`,
    )
    const manual = created[0]!

    await normalizePerson(db, PERSON)

    const { rows } = await db.query<{
      full_name: string
      email: string
      relationship_notes: string
      updated_at: Date
    }>(
      `select full_name, email, relationship_notes, updated_at from official where id = $1`,
      [manual.id],
    )
    const after = rows[0]!

    expect(after.full_name).toBe('Tammy Duckworth')
    expect(after.email).toBe('senator@duckworth.senate.gov')
    expect(after.relationship_notes).toBe('Prefers the web form.')
    // Untouched means untouched — the updated_at trigger never fired.
    expect(after.updated_at).toEqual(manual.updated_at)
    expect(await count('official')).toBe(2) // the alder landed alongside, not on top of, her
  })
})
