import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { migrate } from './migrate'
import {
  confirmMatch,
  createOfficialAndConfirm,
  decideMatch,
  findCandidates,
  matchBill,
  reviewQueue,
  ReviewError,
} from './matching'

/**
 * ITLK-7 acceptance, against a real Postgres — pg_trgm similarity and the normalize_name
 * function ARE the matcher, so testing them through a mock would test nothing.
 *
 * Each test in the "three tiers" block maps to an acceptance criterion on the ticket.
 */

const adminUrl = process.env.DATABASE_URL
if (!adminUrl) {
  console.warn('[matching test] DATABASE_URL not set — skipping matcher integration tests')
}

const TEST_DB = `interlock_match_${randomUUID().slice(0, 8)}`

let adminPool: Pool
let pool: Pool
let db: PoolClient

/** Insert an official; returns its id. */
async function official(fields: {
  name: string
  role?: string
  ward?: number | null
  district?: string | null
  sourceIds?: Record<string, string> | null
}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into official (full_name, role, ward, district, source_person_ids)
     values ($1, $2, $3, $4, $5) returning id`,
    [
      fields.name,
      fields.role ?? 'alder',
      fields.ward ?? null,
      fields.district ?? null,
      fields.sourceIds ? JSON.stringify(fields.sourceIds) : null,
    ],
  )
  return rows[0]!.id
}

/** Insert a bill; returns its id. */
async function bill(source = 'chi_clerk', jurisdiction = 'chicago_council'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into bill (source, source_bill_id, identifier, jurisdiction, title, raw)
     values ($1, $2, $3, $4, 'A bill', '{}'::jsonb) returning id`,
    [source, randomUUID(), `O${Math.floor(Math.random() * 9999)}`, jurisdiction],
  )
  return rows[0]!.id
}

/** Insert a sponsorship; returns its id. */
async function sponsorship(
  billId: string,
  fields: { name: string; personId?: string | null; district?: string | null },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into sponsorship (bill_id, sponsor_name, source_person_id, source_district)
     values ($1, $2, $3, $4) returning id`,
    [billId, fields.name, fields.personId ?? null, fields.district ?? null],
  )
  return rows[0]!.id
}

const readSponsorship = async (
  id: string,
): Promise<{ official_id: string | null; match_method: string | null; match_confidence: number | null }> => {
  const { rows } = await db.query(
    `select official_id, match_method, match_confidence from sponsorship where id = $1`,
    [id],
  )
  return rows[0]!
}

// One throwaway database for the whole file — at file scope, not inside a describe, so
// the pool outlives the first block.
beforeAll(async () => {
  if (!adminUrl) return
  adminPool = new Pool({ connectionString: adminUrl, max: 1 })
  await adminPool.query(`create database ${TEST_DB}`)
  const testUrl = new URL(adminUrl)
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

describe.skipIf(!adminUrl)('normalize_name', () => {
  const normalized = async (raw: string): Promise<string> => {
    const { rows } = await db.query<{ n: string }>(`select normalize_name($1) as n`, [raw])
    return rows[0]!.n
  }

  test('reconciles the two conventions the sources actually use', async () => {
    // eLMS writes "Last, First M."; LegiScan writes "First Last". Same person.
    expect(await normalized('Lopez, Raymond A.')).toBe('raymond lopez')
    expect(await normalized('Raymond A. Lopez')).toBe('raymond lopez')
    expect(await normalized('Raymond Lopez')).toBe('raymond lopez')
  })

  test('strips the parenthetical ward from the brief’s own example', async () => {
    expect(await normalized('Smith, John (Ward 12)')).toBe('john smith')
    expect(await normalized('John Smith')).toBe('john smith')
  })

  test('folds the accents that actually occur on Chicago and Springfield rosters', async () => {
    expect(await normalized('Aarón M. Ortíz')).toBe('aaron ortiz')
    expect(await normalized('Lilian Jiménez')).toBe('lilian jimenez')
    expect(await normalized('Zalewski, Michael R. ')).toBe('michael zalewski')
  })

  test('drops honorifics, generational suffixes and quoted nicknames', async () => {
    expect(await normalized('Rep. Bob Morgan')).toBe('bob morgan')
    expect(await normalized('González, Jr., Edgar')).toBe('edgar gonzalez')
    expect(await normalized('Elizabeth "Lisa" Hernandez')).toBe('elizabeth hernandez')
  })

  test('hyphens and apostrophes agree with their absence', async () => {
    expect(await normalized('Meyers-Martin, Debbie')).toBe('debbie meyers martin')
    expect(await normalized("O'Shea, Matthew")).toBe('matthew shea') // "o" is a stray initial
  })
})

describe.skipIf(!adminUrl)('the three tiers', () => {
  afterEach(async () => {
    await db.query('truncate bill, sponsorship, official cascade')
  })

  test('tier 1 — a sponsor whose source person id we know auto-links, with no queue entry', async () => {
    const officialId = await official({
      name: 'Raymond A. Lopez',
      ward: 15,
      sourceIds: { chi_clerk: 'GUID-15' },
    })
    const billId = await bill()
    const id = await sponsorship(billId, { name: 'Lopez, Raymond A.', personId: 'GUID-15', district: '15' })

    const result = await matchBill(db, billId)

    expect(result).toEqual({ linked: 1, queued: 0 })
    const row = await readSponsorship(id)
    expect(row.official_id).toBe(officialId)
    expect(row.match_method).toBe('source_id')
    expect(Number(row.match_confidence)).toBe(1)
    expect(await reviewQueue(db)).toEqual([])
  })

  test('tier 2 — "Smith, John (Ward 12)" auto-links to "John Smith" of ward 12, with its score stored', async () => {
    // The ticket's second criterion, verbatim.
    const officialId = await official({ name: 'John Smith', ward: 12 })
    const billId = await bill()
    const id = await sponsorship(billId, { name: 'Smith, John (Ward 12)', district: '12' })

    const result = await matchBill(db, billId)

    expect(result).toEqual({ linked: 1, queued: 0 })
    const row = await readSponsorship(id)
    expect(row.official_id).toBe(officialId)
    expect(row.match_method).toBe('name_similarity')
    // Normalization makes these identical strings, so the similarity is 1 — the point is
    // that it cleared 0.85 and that the score is on the row.
    expect(Number(row.match_confidence)).toBeGreaterThanOrEqual(0.85)
  })

  test('tier 3 — two Smiths is ambiguous: NO auto-link, and a review row appears', async () => {
    // The ticket's third criterion. Both officials normalize to "john smith", so both
    // score 1.0 — this is precisely the case where a tiebreak rule would be a guess.
    await official({ name: 'John A. Smith', ward: 12 })
    await official({ name: 'John B. Smith', ward: 12 })
    const billId = await bill()
    const id = await sponsorship(billId, { name: 'Smith, John', district: '12' })

    const result = await matchBill(db, billId)

    expect(result).toEqual({ linked: 0, queued: 1 })
    const row = await readSponsorship(id)
    expect(row.official_id).toBeNull()
    expect(row.match_method).toBeNull() // an unmatched row must not claim a method

    const queue = await reviewQueue(db)
    expect(queue).toHaveLength(1)
    expect(queue[0]!.sponsorshipId).toBe(id)
    expect(queue[0]!.candidates.length).toBe(2)
  })

  test('a matching name in the wrong seat is the wrong person, however well it scores', async () => {
    await official({ name: 'John Smith', ward: 3 })
    const billId = await bill()
    const id = await sponsorship(billId, { name: 'Smith, John (Ward 12)', district: '12' })

    const { outcome } = await decideMatch(db, {
      id,
      billId,
      source: 'chi_clerk',
      sponsorName: 'Smith, John (Ward 12)',
      sourcePersonId: null,
      sourceDistrict: '12',
    })

    expect(outcome.matched).toBe(false)
    if (!outcome.matched) expect(outcome.reason).toBe('district_conflict')
  })

  test('a name nobody resembles is queued with no candidates and no confidence', async () => {
    await official({ name: 'Raymond Lopez', ward: 15 })
    const billId = await bill()
    const id = await sponsorship(billId, { name: 'Wholly Unrelated Person' })

    expect(await matchBill(db, billId)).toEqual({ linked: 0, queued: 1 })

    const row = await readSponsorship(id)
    expect(row.official_id).toBeNull()
    expect(row.match_confidence).toBeNull()
    expect((await reviewQueue(db))[0]!.candidates).toEqual([])
  })

  test('a near miss is queued WITH its score, so the reviewer can see how close it came', async () => {
    await official({ name: 'Jonathan Smithers', ward: 12 })
    const billId = await bill()
    const id = await sponsorship(billId, { name: 'Smith, John', district: '12' })

    await matchBill(db, billId)

    const row = await readSponsorship(id)
    expect(row.official_id).toBeNull()
    const confidence = Number(row.match_confidence)
    expect(confidence).toBeGreaterThan(0)
    expect(confidence).toBeLessThan(0.85)
  })

  test('the threshold is config: the same near miss auto-links once the bar is lowered', async () => {
    const officialId = await official({ name: 'Jonathan Smithers', ward: 12 })
    const billId = await bill()
    const id = await sponsorship(billId, { name: 'Smith, John', district: '12' })

    expect(await matchBill(db, billId, 0.3)).toEqual({ linked: 1, queued: 0 })
    expect((await readSponsorship(id)).official_id).toBe(officialId)
  })

  test('an already-matched sponsorship is never revisited by a later poll', async () => {
    const first = await official({ name: 'John Smith', ward: 12, sourceIds: { chi_clerk: 'P1' } })
    const billId = await bill()
    const id = await sponsorship(billId, { name: 'Smith, John', personId: 'P1', district: '12' })

    await matchBill(db, billId)
    expect((await readSponsorship(id)).official_id).toBe(first)

    // A second, equally plausible official turns up later. The existing match is a fact
    // about the world (and possibly a human's decision) — re-matching must not touch it.
    await official({ name: 'John Smith', ward: 12 })
    expect(await matchBill(db, billId)).toEqual({ linked: 0, queued: 0 })
    expect((await readSponsorship(id)).official_id).toBe(first)
  })

  test('a sponsor listed twice on one bill under two spellings does not fail the ingest', async () => {
    // sponsorship_matched_uniq (bill_id, official_id) would reject the second link.
    // Failing the whole bill over a duplicate sponsor line is a bad trade; the second row
    // goes to review instead.
    await official({ name: 'John Smith', ward: 12 })
    const billId = await bill()
    await sponsorship(billId, { name: 'Smith, John', district: '12' })
    await sponsorship(billId, { name: 'John Smith', district: '12' })

    const result = await matchBill(db, billId)

    expect(result.linked).toBe(1)
    expect(result.queued).toBe(1)
  })

  test('matching is re-attempted on every poll, so a late-seeded official unblocks its queue', async () => {
    const billId = await bill()
    const id = await sponsorship(billId, { name: 'Lopez, Raymond A.', personId: 'GUID-15', district: '15' })

    // Poll 1: the bill arrives before the person does (pg-boss runs jobs out of order).
    expect(await matchBill(db, billId)).toEqual({ linked: 0, queued: 1 })

    // Poll 2: /person has since been ingested.
    const officialId = await official({
      name: 'Lopez, Raymond A.',
      ward: 15,
      sourceIds: { chi_clerk: 'GUID-15' },
    })
    expect(await matchBill(db, billId)).toEqual({ linked: 1, queued: 0 })
    expect((await readSponsorship(id)).official_id).toBe(officialId)
  })

  test('LegiScan districts compare as text, Chicago wards as numbers', async () => {
    const rep = await official({ name: 'Daniel Didech', role: 'state_rep', district: 'HD-059' })
    const billId = await bill('legiscan_il', 'il_ga')
    const id = await sponsorship(billId, { name: 'Daniel Didech', district: 'HD-059' })

    await matchBill(db, billId)
    expect((await readSponsorship(id)).official_id).toBe(rep)

    // eLMS zero-pads its ward ("03"), which must still equal ward 3.
    const alder = await official({ name: 'Pat Dowell', ward: 3 })
    const chiBill = await bill()
    const chiId = await sponsorship(chiBill, { name: 'Dowell, Pat', district: '03' })

    await matchBill(db, chiBill)
    expect((await readSponsorship(chiId)).official_id).toBe(alder)
  })

  test('an official with no seat on file is not treated as disagreeing', async () => {
    // null district means "nobody said", which is not the same as a conflict.
    const officialId = await official({ name: 'John Smith', ward: null, district: null })
    const billId = await bill()
    const id = await sponsorship(billId, { name: 'Smith, John', district: '12' })

    await matchBill(db, billId)
    expect((await readSponsorship(id)).official_id).toBe(officialId)
  })
})

describe.skipIf(!adminUrl)('the review queue', () => {
  afterEach(async () => {
    await db.query('truncate bill, sponsorship, official cascade')
  })

  test('one click confirms, and the SAME sponsor auto-links at tier 1 from then on', async () => {
    // The ticket's third criterion, second half — the whole point of the queue.
    await official({ name: 'John A. Smith', ward: 12 })
    const chosen = await official({ name: 'John B. Smith', ward: 12 })

    const firstBill = await bill()
    const firstSponsor = await sponsorship(firstBill, {
      name: 'Smith, John',
      personId: 'P-SMITH',
      district: '12',
    })

    // Ambiguous → queued, exactly as the tier-3 test showed.
    expect(await matchBill(db, firstBill)).toEqual({ linked: 0, queued: 1 })

    // The human resolves it.
    await confirmMatch(db, firstSponsor, chosen)

    const row = await readSponsorship(firstSponsor)
    expect(row.official_id).toBe(chosen)
    expect(row.match_method).toBe('manual')

    // The confirm backfilled the source id onto the official...
    const { rows } = await db.query<{ ids: Record<string, string> }>(
      `select source_person_ids as ids from official where id = $1`,
      [chosen],
    )
    expect(rows[0]!.ids).toEqual({ chi_clerk: 'P-SMITH' })

    // ...so the next bill this person sponsors resolves at tier 1, with no queue entry —
    // even though the two Smiths are still just as ambiguous by name.
    const secondBill = await bill()
    const secondSponsor = await sponsorship(secondBill, {
      name: 'Smith, John',
      personId: 'P-SMITH',
      district: '12',
    })

    expect(await matchBill(db, secondBill)).toEqual({ linked: 1, queued: 0 })
    const second = await readSponsorship(secondSponsor)
    expect(second.official_id).toBe(chosen)
    expect(second.match_method).toBe('source_id')
    expect(await reviewQueue(db)).toEqual([])
  })

  test('confirming merges the source id — it never clobbers another source’s', async () => {
    // One person, two sources. Wiping the LegiScan id to write the eLMS one would undo a
    // tier-1 match the other source already depends on.
    const officialId = await official({
      name: 'John Smith',
      ward: 12,
      sourceIds: { legiscan_il: '1004' },
    })
    const billId = await bill()
    const id = await sponsorship(billId, { name: 'Totally Different Spelling', personId: 'GUID-9' })

    await confirmMatch(db, id, officialId)

    const { rows } = await db.query<{ ids: Record<string, string> }>(
      `select source_person_ids as ids from official where id = $1`,
      [officialId],
    )
    expect(rows[0]!.ids).toEqual({ legiscan_il: '1004', chi_clerk: 'GUID-9' })
  })

  test('confirming a person we do not have yet creates them, and they are tier-1 from next poll', async () => {
    const billId = await bill()
    const id = await sponsorship(billId, { name: 'Brand New Alder', personId: 'P-NEW', district: '7' })

    await matchBill(db, billId)
    expect(await reviewQueue(db)).toHaveLength(1)

    const officialId = await createOfficialAndConfirm(db, id, {
      fullName: 'Brand New Alder',
      role: 'alder',
      ward: 7,
    })

    expect((await readSponsorship(id)).official_id).toBe(officialId)
    const { rows } = await db.query<{ ids: Record<string, string> }>(
      `select source_person_ids as ids from official where id = $1`,
      [officialId],
    )
    expect(rows[0]!.ids).toEqual({ chi_clerk: 'P-NEW' })
    expect(await reviewQueue(db)).toEqual([])
  })

  test('confirming a row someone else already confirmed is a conflict, not a silent overwrite', async () => {
    const first = await official({ name: 'John Smith', ward: 12 })
    const second = await official({ name: 'Jane Doe', ward: 3 })
    const billId = await bill()
    const id = await sponsorship(billId, { name: 'Smith, John', district: '12' })

    await confirmMatch(db, id, first)
    await expect(confirmMatch(db, id, second)).rejects.toBeInstanceOf(ReviewError)
    expect((await readSponsorship(id)).official_id).toBe(first)
  })

  test('candidates are recomputed live, so an official seeded after queueing shows up', async () => {
    const billId = await bill()
    await sponsorship(billId, { name: 'Smith, John', district: '12' })
    await matchBill(db, billId)

    expect((await reviewQueue(db))[0]!.candidates).toEqual([])

    // Ingest seeds the person an hour later. A cached candidate list would hide them.
    await official({ name: 'John Smith', ward: 12 })

    const candidates = (await reviewQueue(db))[0]!.candidates
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.fullName).toBe('John Smith')
    expect(candidates[0]!.districtAgrees).toBe(true)
  })

  test('findCandidates reports a seat conflict rather than hiding the candidate', async () => {
    await official({ name: 'John Smith', ward: 3 })

    const candidates = await findCandidates(db, {
      sponsorName: 'Smith, John (Ward 12)',
      sourceDistrict: '12',
    })

    // The reviewer should see the near-match AND why it was rejected — hiding it would
    // leave them wondering why an obvious-looking person wasn't offered.
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.score).toBeGreaterThanOrEqual(0.85)
    expect(candidates[0]!.districtAgrees).toBe(false)
  })
})
