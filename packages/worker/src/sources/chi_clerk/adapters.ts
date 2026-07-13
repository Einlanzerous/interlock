import type { PoolClient } from 'pg'
import type { OfficialRole } from '@interlock/shared'
import { toActionClassification, toBillStatus, toSponsorType } from './maps'

/**
 * eLMS payload → canonical tables (ITLK-5).
 *
 * Every adapter here is **write-idempotent**: re-normalizing an unchanged payload
 * writes zero rows. That's an acceptance criterion, not an optimization — it's what
 * lets the differ in ITLK-8 treat "a row changed" as "the source actually moved"
 * rather than "we polled again". Two mechanisms do the work:
 *
 *   1. `bill` short-circuits on an unchanged `lastPublicationDate` (eLMS's own
 *      change primitive) and never touches the row or its children.
 *   2. Everything else updates through `is distinct from` row comparisons, so an
 *      identical payload updates 0 rows and never bumps `updated_at`.
 *
 * Adapters run inside the caller's transaction (the process_record job), so a
 * throw rolls the whole record back and pg-boss retries it.
 */

const SOURCE = 'chi_clerk'
const JURISDICTION = 'chicago_council'

/**
 * The Clerk's public record page — a different host from the API. The site is a SPA
 * that deep-links matters by query param.
 */
const PUBLIC_MATTER_URL = 'https://chicityclerkelms.chicago.gov/Matter/'

/** What a normalize call actually wrote — asserted by the idempotency tests. */
export interface NormalizeResult {
  writes: number
  billId?: string
  officialId?: string
  committeeId?: string
  /** True when an unchanged payload short-circuited before any write. */
  unchanged?: boolean
}

// ---------------------------------------------------------------------------
// matter → bill + bill_action + sponsorship
// ---------------------------------------------------------------------------

export async function normalizeMatter(
  db: PoolClient,
  payload: Record<string, unknown>,
): Promise<NormalizeResult> {
  const matterId = str(payload.matterId)
  if (!matterId) throw new Error('[chi_clerk] matter payload has no matterId')

  const lastPublicationDate = str(payload.lastPublicationDate)

  // eLMS republishes a matter with a fresh lastPublicationDate whenever anything
  // about it changes, so an unchanged one means nothing downstream can have moved.
  const { rows: existing } = await db.query<{ id: string; source_last_modified: Date | null }>(
    `select id, source_last_modified from bill where source = $1 and source_bill_id = $2`,
    [SOURCE, matterId],
  )
  const prior = existing[0]
  if (prior && sameInstant(prior.source_last_modified, lastPublicationDate)) {
    return { writes: 0, billId: prior.id, unchanged: true }
  }

  const actions = arr(payload.actions)
  const status = toBillStatus(str(payload.status), str(payload.subStatus))
  const latest = latestAction(actions)

  // title is NOT NULL; eLMS occasionally leaves it blank, so fall back to something
  // a human can still recognize rather than dropping the bill.
  const title =
    str(payload.title) ?? str(payload.shortTitle) ?? str(payload.recordNumber)?.trim() ?? '(untitled)'

  const billValues = [
    SOURCE,
    matterId,
    str(payload.recordNumber)?.trim() ?? matterId, // recordNumber carries trailing spaces
    JURISDICTION,
    payload.fileYear != null ? String(payload.fileYear) : null,
    title,
    str(payload.type),
    status,
    latest ? actionDescription(latest) : null,
    latest ? toDate(str(latest.actionDate)) : null,
    toDate(str(payload.introductionDate)),
    lastPublicationDate,
    `${PUBLIC_MATTER_URL}?matterId=${matterId}`,
    fullTextUrl(payload),
    JSON.stringify(payload),
  ]

  const { rows } = await db.query<{ id: string }>(
    `insert into bill (
       source, source_bill_id, identifier, jurisdiction, session, title, bill_type, status,
       last_action_text, last_action_date, introduced_date, source_last_modified,
       source_url, full_text_url, raw
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (source, source_bill_id) do update set
       identifier           = excluded.identifier,
       session              = excluded.session,
       title                = excluded.title,
       bill_type            = excluded.bill_type,
       status               = excluded.status,
       last_action_text     = excluded.last_action_text,
       last_action_date     = excluded.last_action_date,
       introduced_date      = excluded.introduced_date,
       source_last_modified = excluded.source_last_modified,
       source_url           = excluded.source_url,
       full_text_url        = excluded.full_text_url,
       raw                  = excluded.raw
     returning id`,
    billValues,
  )
  const billId = rows[0]!.id
  let writes = 1

  writes += await writeActions(db, billId, payload, actions)
  writes += await writeSponsors(db, billId, arr(payload.sponsors))

  return { writes, billId }
}

/** Actions dedup on (bill_id, source_action_id) — re-polls never duplicate history. */
async function writeActions(
  db: PoolClient,
  billId: string,
  payload: Record<string, unknown>,
  actions: Array<Record<string, unknown>>,
): Promise<number> {
  let writes = 0
  const seen = new Set<string>()

  for (const [index, action] of actions.entries()) {
    const historyId = str(action.historyId)
    if (!historyId || seen.has(historyId)) continue
    seen.add(historyId)

    const actionDate = toDate(str(action.actionDate))
    if (!actionDate) {
      // action_date is NOT NULL and inventing one would corrupt the timeline.
      console.warn(`[chi_clerk] action ${historyId} has no actionDate — skipping`)
      continue
    }

    const { rowCount } = await db.query(
      `insert into bill_action
         (bill_id, sequence, action_date, description, classification, actor, source_action_id, raw)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (bill_id, source_action_id) do nothing`,
      [
        billId,
        int(action.sort) ?? index,
        actionDate,
        actionDescription(action),
        toActionClassification(str(action.actionName)),
        str(action.actionByName),
        historyId,
        JSON.stringify(action), // inline votes[] ride along verbatim
      ],
    )
    writes += rowCount ?? 0
  }

  writes += await writeCommitteeReferral(db, billId, payload, actions)
  return writes
}

/**
 * The committee a matter was referred to.
 *
 * There is no bill↔committee join in the canonical schema, and referral is really an
 * event, so it's modeled as a `referred` action. Most matters already carry one from
 * eLMS; this only synthesizes a row when `committeReferral` (sic — the API misspells
 * it) names a committee that no action records, so the referral is never silently lost.
 */
async function writeCommitteeReferral(
  db: PoolClient,
  billId: string,
  payload: Record<string, unknown>,
  actions: Array<Record<string, unknown>>,
): Promise<number> {
  const committee = str(payload.committeReferral)?.trim()
  if (!committee) return 0

  const alreadyRecorded = actions.some(
    (action) => toActionClassification(str(action.actionName), () => {}) === 'referred',
  )
  if (alreadyRecorded) return 0

  // Referral happens at introduction; without a date there's no honest row to write.
  const actionDate = toDate(str(payload.introductionDate)) ?? toDate(str(payload.recordCreateDate))
  if (!actionDate) return 0

  const { rowCount } = await db.query(
    `insert into bill_action
       (bill_id, sequence, action_date, description, classification, actor, source_action_id, raw)
     values ($1,$2,$3,$4,'referred',$5,$6,$7)
     on conflict (bill_id, source_action_id) do nothing`,
    [
      billId,
      0, // referral precedes the eLMS actions, whose `sort` starts at 70
      actionDate,
      `Referred to ${committee}`,
      committee,
      'chi_clerk:committee-referral', // stable per bill → idempotent
      JSON.stringify({ synthesized: 'committeReferral', committeReferral: committee }),
    ],
  )
  return rowCount ?? 0
}

/**
 * Sponsor rows. `official_id` stays null — resolving a sponsor to an official is
 * ITLK-7's job, and guessing an identity here is exactly what the brief forbids. The
 * eLMS `personId` GUID is carried onto the row as `source_person_id` (0003), which is
 * ITLK-7's tier-1 match key: ingest is the only stage that holds it, and re-deriving it
 * from `bill.raw` later would put a source payload back in the matcher's hands.
 */
async function writeSponsors(
  db: PoolClient,
  billId: string,
  sponsors: Array<Record<string, unknown>>,
): Promise<number> {
  let writes = 0
  const seen = new Set<string>()

  for (const [index, sponsor] of sponsors.entries()) {
    const name = str(sponsor.sponsorName)?.trim()
    if (!name || seen.has(name)) continue // (bill_id, sponsor_name) is unique while unmatched
    seen.add(name)

    const sponsorType = toSponsorType(str(sponsor.sponsorType))
    const sourcePersonId = str(sponsor.personId)

    // Insert only when this bill has no row for the name yet — checking regardless of
    // official_id, so a sponsor ITLK-7 has already matched isn't re-inserted as a
    // second, unmatched row.
    const inserted = await db.query(
      `insert into sponsorship (bill_id, sponsor_name, sponsor_type, sequence, source_person_id)
       select $1, $2, $3, $4, $5
       where not exists (select 1 from sponsorship where bill_id = $1 and sponsor_name = $2)
       on conflict do nothing`, // two staged observations of one matter can race here
      [billId, name, sponsorType, index, sourcePersonId],
    )
    if (inserted.rowCount) {
      writes += inserted.rowCount
      continue
    }

    const updated = await db.query(
      `update sponsorship set sponsor_type = $3, sequence = $4, source_person_id = $5
       where bill_id = $1 and sponsor_name = $2
         and (sponsor_type, sequence, source_person_id)
             is distinct from ($3::sponsor_type, $4::int, $5::text)`,
      [billId, name, sponsorType, index, sourcePersonId],
    )
    writes += updated.rowCount ?? 0
  }
  return writes
}

// ---------------------------------------------------------------------------
// person → official
// ---------------------------------------------------------------------------

export async function normalizePerson(
  db: PoolClient,
  payload: Record<string, unknown>,
): Promise<NormalizeResult> {
  const personId = str(payload.personId)
  if (!personId) throw new Error('[chi_clerk] person payload has no personId')
  return upsertOfficial(db, personId, payload)
}

/**
 * Upsert an official keyed on the eLMS `personId` — the stable GUID that ITLK-7's
 * tier-1 match relies on. Shared by the person and body adapters: `/body.members[]`
 * carries the same person shape, so a committee can seed the officials it links
 * without depending on the person phase having run first.
 */
async function upsertOfficial(
  db: PoolClient,
  personId: string,
  person: Record<string, unknown>,
): Promise<NormalizeResult> {
  const fullName = str(person.displayName)?.trim()
  if (!fullName) throw new Error(`[chi_clerk] person ${personId} has no displayName`)

  const ward = int(person.ward) // "Mayor" and friends aren't numeric → null
  const values = [
    JSON.stringify({ [SOURCE]: personId }),
    fullName,
    officialRole(person),
    ward,
    str(person.email) || null,
    str(person.phone) || null,
    str(person.site) || null,
    officeAddress(person),
    person.isActive !== false,
  ]

  const { rows: found } = await db.query<{ id: string }>(
    `select id from official where source_person_ids @> $1::jsonb limit 1`,
    [JSON.stringify({ [SOURCE]: personId })],
  )
  const existing = found[0]

  if (!existing) {
    const { rows } = await db.query<{ id: string }>(
      `insert into official
         (source_person_ids, full_name, role, ward, email, phone, web_form_url, office_address, active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning id`,
      values,
    )
    return { writes: 1, officialId: rows[0]!.id }
  }

  // Identical payload → 0 rows updated, and the updated_at trigger never fires.
  const { rowCount } = await db.query(
    `update official set
       full_name = $2, role = $3, ward = $4, email = $5, phone = $6,
       web_form_url = $7, office_address = $8, active = $9
     where id = $1
       and (full_name, role, ward, email, phone, web_form_url, office_address, active)
           is distinct from
           ($2::text, $3::official_role, $4::int, $5::text, $6::text, $7::text, $8::text, $9::boolean)`,
    [existing.id, ...values.slice(1)],
  )
  return { writes: rowCount ?? 0, officialId: existing.id, unchanged: (rowCount ?? 0) === 0 }
}

/** eLMS puts the ward number in `ward`, or a word like "Mayor" for non-alders. */
function officialRole(person: Record<string, unknown>): OfficialRole {
  const ward = str(person.ward)?.trim().toLowerCase()
  if (ward && /^\d+$/.test(ward)) return 'alder'
  if (ward === 'mayor') return 'mayor'
  if (ward === 'clerk' || ward === 'treasurer') return 'other'
  return int(person.ward) != null ? 'alder' : 'other'
}

function officeAddress(person: Record<string, unknown>): string | null {
  // Prefer the ward office; fall back to the City Hall address (`*2` fields).
  const primary = joinAddress(person, '')
  return primary ?? joinAddress(person, '2')
}

function joinAddress(person: Record<string, unknown>, suffix: string): string | null {
  const street = str(person[`address${suffix}`])?.trim()
  if (!street) return null
  const city = str(person[`city${suffix}`])?.trim()
  const state = str(person[`state${suffix}`])?.trim()
  const zip = str(person[`zip${suffix}`])?.trim()
  const tail = [city, state].filter(Boolean).join(', ')
  return [street, tail, zip].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// body → committee + membership (+ the officials it links)
// ---------------------------------------------------------------------------

export async function normalizeBody(
  db: PoolClient,
  payload: Record<string, unknown>,
): Promise<NormalizeResult> {
  const bodyId = str(payload.bodyId)
  if (!bodyId) throw new Error('[chi_clerk] body payload has no bodyId')
  const name = str(payload.body)?.trim()
  if (!name) throw new Error(`[chi_clerk] body ${bodyId} has no name`)

  const classification = str(payload.bodyType)
  let writes = 0

  const { rows: found } = await db.query<{ id: string }>(
    `select id from committee where source = $1 and source_body_id = $2`,
    [SOURCE, bodyId],
  )
  let committeeId = found[0]?.id

  if (!committeeId) {
    const { rows } = await db.query<{ id: string }>(
      `insert into committee (source, source_body_id, name, classification, jurisdiction)
       values ($1,$2,$3,$4,$5)
       returning id`,
      [SOURCE, bodyId, name, classification, JURISDICTION],
    )
    committeeId = rows[0]!.id
    writes += 1
  } else {
    const { rowCount } = await db.query(
      `update committee set name = $2, classification = $3
       where id = $1 and (name, classification) is distinct from ($2::text, $3::text)`,
      [committeeId, name, classification],
    )
    writes += rowCount ?? 0
  }

  // members[] has the same shape as /person, so seed each official here rather than
  // depending on the person phase — pg-boss may run these jobs in either order.
  for (const member of arr(payload.members)) {
    const personId = str(member.personId)
    if (!personId || !str(member.displayName)) continue

    const official = await upsertOfficial(db, personId, member)
    writes += official.writes

    const { rowCount } = await db.query(
      `insert into membership (official_id, committee_id, role)
       values ($1,$2,$3)
       on conflict (official_id, committee_id) do update set role = excluded.role
       where membership.role is distinct from excluded.role`,
      [official.officialId, committeeId, str(member.memberType)],
    )
    writes += rowCount ?? 0
  }

  return { writes, committeeId }
}

// ---------------------------------------------------------------------------
// shaping helpers
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function int(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) return Number.parseInt(value, 10)
  return null
}

function arr(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Array<Record<string, unknown>>) : []
}

/**
 * eLMS timestamps are UTC but encode a Chicago-local calendar day (action dates land
 * at 05:00Z = local midnight), so the UTC date part is the correct local date.
 */
function toDate(iso: string | null): string | null {
  if (!iso) return null
  const day = iso.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

/** `description` is NOT NULL, and eLMS leaves actionText — and sometimes actionName — blank. */
function actionDescription(action: Record<string, unknown>): string {
  return (
    str(action.actionText)?.trim() ||
    str(action.actionName)?.trim() ||
    '(no description)'
  )
}

/** The bill's most recent action, by date then by eLMS `sort`. */
function latestAction(
  actions: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  return [...actions]
    .filter((a) => str(a.actionDate))
    .sort((a, b) => {
      const byDate = Date.parse(str(a.actionDate)!) - Date.parse(str(b.actionDate)!)
      return byDate !== 0 ? byDate : (int(a.sort) ?? 0) - (int(b.sort) ?? 0)
    })
    .pop()
}

/** Attachment URLs only — v1 stores links, it does not parse PDFs. */
function fullTextUrl(payload: Record<string, unknown>): string | null {
  const attachments = arr(payload.attachments)
  const legislation = attachments.find((a) => str(a.attachmentType) === 'Legislation')
  return str((legislation ?? attachments[0])?.path)
}

/** True when the stored watermark already matches the payload's. */
function sameInstant(stored: Date | null, incoming: string | null): boolean {
  if (!stored || !incoming) return false
  const at = Date.parse(incoming)
  return !Number.isNaN(at) && stored.getTime() === at
}
