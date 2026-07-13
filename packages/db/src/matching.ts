import type { Pool, PoolClient } from 'pg'

/**
 * Sponsor → Official identity resolution (ITLK-7, brief §2).
 *
 * The governing rule is the brief's: **never silently guess an identity.** Every
 * decision here is either exact, or confidently fuzzy, or handed to a human — there is
 * no fourth outcome where we link a sponsorship to an Official because it seemed likely.
 *
 *   Tier 1 — the source's own stable person id. eLMS `personId`, LegiScan `people_id`,
 *            both captured onto the sponsorship row at ingest (0003). Not a guess at
 *            all: the source is telling us who this is. Auto-links, confidence 1.
 *   Tier 2 — normalized name + ward/district agreement, scored with pg_trgm. Auto-links
 *            only when exactly ONE Official clears the threshold. Two plausible Smiths
 *            is not a close call to be broken by a tiebreak rule; it is the definition
 *            of ambiguous, and it goes to tier 3.
 *   Tier 3 — no auto-link. The sponsorship keeps `official_id = null` and carries the
 *            best score it saw, and a human resolves it from the review queue.
 *
 * This lives in @interlock/db rather than in the worker because two callers need the
 * *same* scoring: the worker matches during ingest, and the web API shows a reviewer the
 * candidates for an unmatched row. Two implementations of "how similar are these names"
 * would drift, and the drift would be invisible.
 */

/** Anything with `.query` — a Pool, or a PoolClient inside the ingest transaction. */
export type Db = Pick<Pool | PoolClient, 'query'>

/**
 * Auto-link at or above this pg_trgm similarity. Config, not code — the brief flags it
 * as expected to need tuning, so callers thread it through from env
 * (`MATCH_NAME_SIMILARITY_THRESHOLD`). This is only the default.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.85

/** Why a sponsorship was not auto-linked — shown to the reviewer, so it must be honest. */
export type UnmatchedReason =
  | 'no_candidate' // nothing in `official` looks like this name at all
  | 'below_threshold' // the best candidate was not similar enough
  | 'ambiguous' // two or more candidates cleared the bar; picking one would be a guess
  | 'district_conflict' // the name matched, but the seat did not

export type MatchOutcome =
  | { matched: true; tier: 1 | 2; officialId: string; method: 'source_id' | 'name_similarity'; confidence: number }
  | { matched: false; reason: UnmatchedReason; confidence: number | null }

export interface Candidate {
  officialId: string
  fullName: string
  role: string
  ward: number | null
  district: string | null
  /** pg_trgm similarity of the two normalized names, 0..1. */
  score: number
  /**
   * Did the source's district for this sponsor agree with the Official's seat?
   * `null` means "nobody said" — one side or the other has no district on file, which
   * is not the same as a disagreement and must not be treated as one.
   */
  districtAgrees: boolean | null
}

export interface SponsorshipToMatch {
  id: string
  billId: string
  /** The bill's source — the key under which tier 1 looks up `source_person_ids`. */
  source: string
  sponsorName: string
  sourcePersonId: string | null
  sourceDistrict: string | null
}

/**
 * Officials whose normalized name is at all similar to this sponsor's.
 *
 * The `%` operator is pg_trgm's, so this rides the functional GIN index from 0004
 * (`normalize_name(full_name)`) rather than scanning `official`. It is a *prefilter* at
 * pg_trgm's own default (0.3); our real threshold is applied by the caller, so the
 * review queue can show a reviewer the near-misses that were correctly rejected.
 */
export async function findCandidates(
  db: Db,
  sponsor: Pick<SponsorshipToMatch, 'sponsorName' | 'sourceDistrict'>,
  limit = 10,
): Promise<Candidate[]> {
  const { rows } = await db.query<{
    id: string
    full_name: string
    role: string
    ward: number | null
    district: string | null
    score: number
    district_agrees: boolean | null
  }>(
    `select o.id, o.full_name, o.role, o.ward, o.district,
            similarity(normalize_name(o.full_name), normalize_name($1)) as score,
            case
              -- The source told us nothing about the seat: no opinion, not a conflict.
              when $2::text is null or btrim($2) = '' then null
              -- Chicago: eLMS sends a (possibly zero-padded) ward number.
              when o.ward is not null and btrim($2) ~ '^[0-9]+$' then (o.ward = btrim($2)::int)
              -- Illinois GA: LegiScan sends "HD-059" / "SD-030".
              when o.district is not null then (upper(btrim(o.district)) = upper(btrim($2)))
              -- The Official has no seat on file (a manually added federal contact, say).
              else null
            end as district_agrees
     from official o
     where normalize_name(o.full_name) % normalize_name($1)
     order by score desc, o.full_name
     limit $3`,
    [sponsor.sponsorName, sponsor.sourceDistrict, limit],
  )

  return rows.map((row) => ({
    officialId: row.id,
    fullName: row.full_name,
    role: row.role,
    ward: row.ward,
    district: row.district,
    score: Number(row.score),
    districtAgrees: row.district_agrees,
  }))
}

/** Tier 1: the source's own person id. An exact lookup, not a guess. */
export async function findBySourcePersonId(
  db: Db,
  source: string,
  sourcePersonId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `select id from official where source_person_ids @> jsonb_build_object($1::text, $2::text) limit 1`,
    [source, sourcePersonId],
  )
  return rows[0]?.id ?? null
}

/**
 * Decide — but do not write — how one sponsorship resolves.
 *
 * Split out from the writing so the review queue can explain a decision to a human
 * without re-making it, and so the tier logic is testable without a transaction.
 */
export async function decideMatch(
  db: Db,
  sponsorship: SponsorshipToMatch,
  threshold = DEFAULT_SIMILARITY_THRESHOLD,
): Promise<{ outcome: MatchOutcome; candidates: Candidate[] }> {
  // --- Tier 1.
  if (sponsorship.sourcePersonId) {
    const officialId = await findBySourcePersonId(db, sponsorship.source, sponsorship.sourcePersonId)
    if (officialId) {
      return {
        outcome: { matched: true, tier: 1, officialId, method: 'source_id', confidence: 1 },
        candidates: [],
      }
    }
  }

  // --- Tier 2.
  const candidates = await findCandidates(db, sponsorship)
  if (candidates.length === 0) {
    return { outcome: { matched: false, reason: 'no_candidate', confidence: null }, candidates }
  }

  const best = candidates[0]!.score
  const overThreshold = candidates.filter((c) => c.score >= threshold)

  if (overThreshold.length === 0) {
    return { outcome: { matched: false, reason: 'below_threshold', confidence: best }, candidates }
  }

  // A name that matches the wrong seat is the wrong person, however well it scores.
  const plausible = overThreshold.filter((c) => c.districtAgrees !== false)
  if (plausible.length === 0) {
    return { outcome: { matched: false, reason: 'district_conflict', confidence: best }, candidates }
  }

  // Two Smiths who both clear the bar is not a tiebreak problem — it is the ambiguous
  // case the brief says must never be auto-linked.
  if (plausible.length > 1) {
    return { outcome: { matched: false, reason: 'ambiguous', confidence: best }, candidates }
  }

  const winner = plausible[0]!
  return {
    outcome: {
      matched: true,
      tier: 2,
      officialId: winner.officialId,
      method: 'name_similarity',
      confidence: winner.score,
    },
    candidates,
  }
}

/** Unmatched sponsorships of a bill, with everything the tiers need. */
async function unmatchedOf(db: Db, billId: string): Promise<SponsorshipToMatch[]> {
  const { rows } = await db.query<{
    id: string
    bill_id: string
    source: string
    sponsor_name: string
    source_person_id: string | null
    source_district: string | null
  }>(
    `select s.id, s.bill_id, b.source, s.sponsor_name, s.source_person_id, s.source_district
     from sponsorship s
     join bill b on b.id = s.bill_id
     where s.bill_id = $1 and s.official_id is null
     order by s.sequence nulls last, s.sponsor_name`,
    [billId],
  )
  return rows.map((row) => ({
    id: row.id,
    billId: row.bill_id,
    source: row.source,
    sponsorName: row.sponsor_name,
    sourcePersonId: row.source_person_id,
    sourceDistrict: row.source_district,
  }))
}

export interface MatchBillResult {
  linked: number
  queued: number
}

/**
 * Resolve every unmatched sponsorship on a bill. Runs inside the ingest transaction, so
 * a throw rolls back the normalize that produced these rows too.
 *
 * Already-matched rows are never revisited: a match, once made, is a fact about the
 * world (and possibly a human's decision), not something a later poll gets to overwrite.
 */
export async function matchBill(
  db: Db,
  billId: string,
  threshold = DEFAULT_SIMILARITY_THRESHOLD,
): Promise<MatchBillResult> {
  let linked = 0
  let queued = 0

  for (const sponsorship of await unmatchedOf(db, billId)) {
    const { outcome } = await decideMatch(db, sponsorship, threshold)

    if (!outcome.matched) {
      // Record what we saw, so the reviewer isn't guessing at why it's here. match_method
      // stays null — the row is unmatched, and claiming a method would misdescribe it.
      await db.query(`update sponsorship set match_confidence = $2 where id = $1`, [
        sponsorship.id,
        outcome.confidence,
      ])
      queued++
      continue
    }

    const ok = await link(db, sponsorship, outcome.officialId, outcome.method, outcome.confidence)
    if (ok) linked++
    else queued++
  }

  return { linked, queued }
}

/**
 * Write the link.
 *
 * Returns false rather than throwing when the bill already has a sponsorship row bound
 * to this Official. That collides with `sponsorship_matched_uniq (bill_id, official_id)`
 * and it is a real thing sources do — the same person listed twice on one bill under two
 * spellings. Failing the whole ingest over a duplicate sponsor line would be a poor
 * trade; leaving the second row for a human is the honest one.
 */
async function link(
  db: Db,
  sponsorship: SponsorshipToMatch,
  officialId: string,
  method: 'source_id' | 'name_similarity' | 'manual',
  confidence: number | null,
): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `select id from sponsorship
     where bill_id = $1 and official_id = $2 and id <> $3
     limit 1`,
    [sponsorship.billId, officialId, sponsorship.id],
  )
  if (rows.length > 0) {
    console.warn(
      `[matcher] bill ${sponsorship.billId} already links official ${officialId}; ` +
        `leaving "${sponsorship.sponsorName}" for review`,
    )
    await db.query(`update sponsorship set match_confidence = $2 where id = $1`, [
      sponsorship.id,
      confidence,
    ])
    return false
  }

  await db.query(
    `update sponsorship
     set official_id = $2, match_method = $3, match_confidence = $4
     where id = $1`,
    [sponsorship.id, officialId, method, confidence],
  )
  return true
}

// ---------------------------------------------------------------------------
// The review queue (tier 3)
// ---------------------------------------------------------------------------

export interface ReviewItem {
  sponsorshipId: string
  sponsorName: string
  sponsorType: string
  sourceDistrict: string | null
  sourcePersonId: string | null
  confidence: number | null
  bill: {
    id: string
    identifier: string
    title: string
    source: string
    jurisdiction: string
  }
  candidates: Candidate[]
}

/**
 * Everything waiting on a human, with its candidates recomputed live.
 *
 * Candidates are not stored. They are a *function* of the current `official` table, and
 * that table keeps growing as ingest runs — an Official seeded an hour after a
 * sponsorship was queued should show up as a candidate for it, and a cached candidate
 * list would hide them. Recomputing is one indexed query per row.
 */
export async function reviewQueue(db: Db, limit = 50, offset = 0): Promise<ReviewItem[]> {
  const { rows } = await db.query<{
    id: string
    sponsor_name: string
    sponsor_type: string
    source_district: string | null
    source_person_id: string | null
    match_confidence: number | null
    bill_id: string
    identifier: string
    title: string
    source: string
    jurisdiction: string
  }>(
    `select s.id, s.sponsor_name, s.sponsor_type, s.source_district, s.source_person_id,
            s.match_confidence,
            b.id as bill_id, b.identifier, b.title, b.source, b.jurisdiction
     from sponsorship s
     join bill b on b.id = s.bill_id
     where s.official_id is null
     order by s.match_confidence desc nulls last, b.last_action_date desc nulls last, s.sponsor_name
     limit $1 offset $2`,
    [limit, offset],
  )

  return Promise.all(
    rows.map(async (row) => ({
      sponsorshipId: row.id,
      sponsorName: row.sponsor_name,
      sponsorType: row.sponsor_type,
      sourceDistrict: row.source_district,
      sourcePersonId: row.source_person_id,
      confidence: row.match_confidence === null ? null : Number(row.match_confidence),
      bill: {
        id: row.bill_id,
        identifier: row.identifier,
        title: row.title,
        source: row.source,
        jurisdiction: row.jurisdiction,
      },
      candidates: await findCandidates(db, {
        sponsorName: row.sponsor_name,
        sourceDistrict: row.source_district,
      }),
    })),
  )
}

export async function reviewQueueCount(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from sponsorship where official_id is null`,
  )
  return rows[0]!.n
}

export class ReviewError extends Error {}

/**
 * The one-click confirm.
 *
 * Links the sponsorship to the Official a human picked, and — the part that matters —
 * **backfills the source's person id onto that Official**. That is what makes the click
 * worth making: the next poll of the same sponsor resolves at tier 1, exactly, without
 * ever reaching the queue again. A confirm that only fixed the row in front of you would
 * have to be repeated on every bill that person ever sponsors.
 *
 * `source_person_ids` is merged, never replaced: an Official can legitimately carry both
 * an eLMS GUID and a LegiScan people_id, and clobbering one with the other would undo a
 * match the *other* source already relies on.
 */
export async function confirmMatch(
  db: Db,
  sponsorshipId: string,
  officialId: string,
): Promise<void> {
  const { rows } = await db.query<{
    id: string
    bill_id: string
    source: string
    sponsor_name: string
    source_person_id: string | null
    official_id: string | null
  }>(
    `select s.id, s.bill_id, b.source, s.sponsor_name, s.source_person_id, s.official_id
     from sponsorship s join bill b on b.id = s.bill_id
     where s.id = $1`,
    [sponsorshipId],
  )
  const sponsorship = rows[0]
  if (!sponsorship) throw new ReviewError(`no sponsorship ${sponsorshipId}`)
  if (sponsorship.official_id) {
    throw new ReviewError(`sponsorship ${sponsorshipId} is already matched`)
  }

  const { rowCount } = await db.query(`select 1 from official where id = $1`, [officialId])
  if (!rowCount) throw new ReviewError(`no official ${officialId}`)

  const clash = await db.query(
    `select 1 from sponsorship where bill_id = $1 and official_id = $2 limit 1`,
    [sponsorship.bill_id, officialId],
  )
  if (clash.rowCount) {
    throw new ReviewError('that official is already a sponsor of this bill')
  }

  await db.query(
    `update sponsorship
     set official_id = $2, match_method = 'manual', match_confidence = 1
     where id = $1`,
    [sponsorshipId, officialId],
  )

  if (sponsorship.source_person_id) {
    await db.query(
      `update official
       set source_person_ids =
             coalesce(source_person_ids, '{}'::jsonb)
             || jsonb_build_object($2::text, $3::text)
       where id = $1`,
      [officialId, sponsorship.source, sponsorship.source_person_id],
    )
  }
}

export interface NewOfficial {
  fullName: string
  role: string
  ward?: number | null
  district?: string | null
  party?: string | null
}

/**
 * Confirm against a person we do not have yet: create the Official, then confirm.
 *
 * The source id is backfilled by `confirmMatch`, so a brand-new Official created this
 * way is tier-1 matchable from its very next poll.
 */
export async function createOfficialAndConfirm(
  db: Db,
  sponsorshipId: string,
  official: NewOfficial,
): Promise<string> {
  const fullName = official.fullName.trim()
  if (!fullName) throw new ReviewError('an official needs a name')

  const { rows } = await db.query<{ id: string }>(
    `insert into official (full_name, role, ward, district, party)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [fullName, official.role, official.ward ?? null, official.district ?? null, official.party ?? null],
  )
  const officialId = rows[0]!.id
  await confirmMatch(db, sponsorshipId, officialId)
  return officialId
}
