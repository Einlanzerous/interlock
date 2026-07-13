import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { toActionClassification, toBillStatus, toBillType, toOfficialRole, toSponsorType } from './maps'

/**
 * LegiScan payload → canonical tables (ITLK-6).
 *
 * Write-idempotent on the same terms as the eLMS adapter: re-normalizing an unchanged
 * payload writes zero rows, which is what lets ITLK-8's differ read "a row changed" as
 * "the source actually moved". Here the short-circuit is exact rather than heuristic —
 * LegiScan gives every bill a `change_hash`, so an unchanged hash means an unchanged
 * bill by the source's own definition.
 *
 * Adapters run inside the caller's transaction (the process_record job), so a throw
 * rolls the whole record back and pg-boss retries it.
 */

const SOURCE = 'legiscan_il'
const JURISDICTION = 'il_ga'

/** What a normalize call actually wrote — asserted by the idempotency tests. */
export interface NormalizeResult {
  writes: number
  billId?: string
  /** True when an unchanged change_hash short-circuited before any write. */
  unchanged?: boolean
}

// ---------------------------------------------------------------------------
// bill → bill + bill_action + sponsorship + official + committee
// ---------------------------------------------------------------------------

export async function normalizeBill(
  db: PoolClient,
  payload: Record<string, unknown>,
): Promise<NormalizeResult> {
  const billId = str(payload.bill_id) ?? num(payload.bill_id)?.toString()
  if (!billId) throw new Error('[legiscan_il] bill payload has no bill_id')

  const changeHash = str(payload.change_hash)

  // LegiScan's own change primitive. An unchanged hash means nothing about this bill
  // has moved, so there is nothing downstream to reconsider either.
  const { rows: existing } = await db.query<{ id: string; change_hash: string | null }>(
    `select id, change_hash from bill where source = $1 and source_bill_id = $2`,
    [SOURCE, billId],
  )
  const prior = existing[0]
  if (prior && changeHash && prior.change_hash === changeHash) {
    return { writes: 0, billId: prior.id, unchanged: true }
  }

  const history = arr(payload.history)
  const progress = arr(payload.progress)
  const latest = latestAction(history)
  const session = obj(payload.session)

  // title is NOT NULL. LegiScan always sends one, but a blank would drop the bill.
  const title = str(payload.title)?.trim() ?? str(payload.bill_number)?.trim() ?? '(untitled)'

  const billValues = [
    SOURCE,
    billId,
    str(payload.bill_number)?.trim() ?? billId,
    JURISDICTION,
    str(session?.session_name) ?? str(session?.session_title),
    title,
    str(payload.description)?.trim() ?? null, // → summary; feeds the FTS index
    toBillType(str(payload.bill_type)),
    toBillStatus(num(payload.status), progress),
    latest ? str(latest.action)?.trim() ?? null : null,
    latest ? toDate(str(latest.date)) : null,
    introducedDate(progress, history),
    changeHash,
    // Prefer the ILGA page over legiscan.com: it is the authoritative record, and the
    // one a user checking our work would open.
    str(payload.state_link) ?? str(payload.url),
    fullTextUrl(payload),
    JSON.stringify(payload),
  ]

  const { rows } = await db.query<{ id: string }>(
    `insert into bill (
       source, source_bill_id, identifier, jurisdiction, session, title, summary, bill_type,
       status, last_action_text, last_action_date, introduced_date, change_hash,
       source_url, full_text_url, raw
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (source, source_bill_id) do update set
       identifier       = excluded.identifier,
       session          = excluded.session,
       title            = excluded.title,
       summary          = excluded.summary,
       bill_type        = excluded.bill_type,
       status           = excluded.status,
       last_action_text = excluded.last_action_text,
       last_action_date = excluded.last_action_date,
       introduced_date  = excluded.introduced_date,
       change_hash      = excluded.change_hash,
       source_url       = excluded.source_url,
       full_text_url    = excluded.full_text_url,
       raw              = excluded.raw
     returning id`,
    billValues,
  )
  const id = rows[0]!.id
  let writes = 1

  writes += await writeActions(db, id, history)
  writes += await writeSponsors(db, id, arr(payload.sponsors))
  writes += await writeCommittee(db, obj(payload.committee))

  return { writes, billId: id }
}

/**
 * History rows → bill_action.
 *
 * **LegiScan history rows have no id.** A row is `{date, action, chamber, importance}`
 * and nothing more, so `source_action_id` — which the schema requires to be stable, and
 * which the `(bill_id, source_action_id)` unique index dedups re-polls on — has to be
 * synthesized.
 *
 * The array index alone would be unsafe: LegiScan backfills history rows, and a single
 * inserted row would renumber everything after it, duplicating the bill's whole timeline
 * on the next poll. So the id is a hash of the row's *content* (date + chamber + action),
 * which survives reordering and backfill. Illinois really does emit the same action twice
 * on one day (two "Added Co-Sponsor" rows for different people collapse to the same text
 * only when the source repeats itself verbatim), so an occurrence counter disambiguates
 * exact content duplicates.
 */
async function writeActions(
  db: PoolClient,
  billId: string,
  history: Array<Record<string, unknown>>,
): Promise<number> {
  let writes = 0
  const occurrences = new Map<string, number>()

  for (const [index, row] of history.entries()) {
    const actionDate = toDate(str(row.date))
    const description = str(row.action)?.trim()
    if (!actionDate || !description) {
      // action_date and description are both NOT NULL, and inventing either would
      // corrupt the timeline the user reads.
      console.warn(`[legiscan_il] bill ${billId} history row ${index} has no date/action — skipping`)
      continue
    }

    const sourceActionId = actionId(row, actionDate, description, occurrences)

    const { rowCount } = await db.query(
      `insert into bill_action
         (bill_id, sequence, action_date, description, classification, actor, source_action_id, raw)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (bill_id, source_action_id) do nothing`,
      [
        billId,
        index,
        actionDate,
        description,
        toActionClassification(description),
        str(row.chamber), // 'H' / 'S'
        sourceActionId,
        JSON.stringify(row),
      ],
    )
    writes += rowCount ?? 0
  }
  return writes
}

/** Content-addressed action id: stable under reordering and backfill. */
function actionId(
  row: Record<string, unknown>,
  actionDate: string,
  description: string,
  occurrences: Map<string, number>,
): string {
  const key = `${actionDate}|${str(row.chamber) ?? ''}|${description}`
  const digest = createHash('sha1').update(key).digest('hex').slice(0, 16)
  const seen = occurrences.get(digest) ?? 0
  occurrences.set(digest, seen + 1)
  // First occurrence keeps the bare digest so the common case stays readable in the DB.
  return seen === 0 ? digest : `${digest}-${seen}`
}

/**
 * Sponsors → `official` (the CRM seed) + `sponsorship` (the join).
 *
 * `official_id` stays null: resolving a sponsor to an official is ITLK-7's job, and the
 * brief is explicit that ingest must never guess an identity. Note that the official row
 * itself IS created here — creating a person and *linking a sponsorship to* a person are
 * different acts, and only the second one can be wrong. `source_person_id` carries
 * LegiScan's `people_id` onto the sponsorship row so ITLK-7's tier-1 match is an exact
 * lookup rather than a re-reading of `bill.raw`.
 */
async function writeSponsors(
  db: PoolClient,
  billId: string,
  sponsors: Array<Record<string, unknown>>,
): Promise<number> {
  let writes = 0
  const seen = new Set<string>()

  for (const [index, sponsor] of sponsors.entries()) {
    const name = str(sponsor.name)?.trim()
    const peopleId = num(sponsor.people_id)
    if (!name || seen.has(name)) continue // (bill_id, sponsor_name) is unique while unmatched
    seen.add(name)

    if (peopleId != null) writes += await upsertOfficial(db, String(peopleId), sponsor)

    const sponsorType = toSponsorType(num(sponsor.sponsor_type_id), num(sponsor.sponsor_order))
    const sequence = num(sponsor.sponsor_order) ?? index
    const sourcePersonId = peopleId != null ? String(peopleId) : null

    const inserted = await db.query(
      `insert into sponsorship (bill_id, sponsor_name, sponsor_type, sequence, source_person_id)
       select $1, $2, $3, $4, $5
       where not exists (select 1 from sponsorship where bill_id = $1 and sponsor_name = $2)
       on conflict do nothing`,
      [billId, name, sponsorType, sequence, sourcePersonId],
    )
    if (inserted.rowCount) {
      writes += inserted.rowCount
      continue
    }

    // Already present — update in place. Never touches official_id or match_method:
    // a re-poll must not undo a match ITLK-7 has already made.
    const updated = await db.query(
      `update sponsorship set sponsor_type = $3, sequence = $4, source_person_id = $5
       where bill_id = $1 and sponsor_name = $2
         and (sponsor_type, sequence, source_person_id)
             is distinct from ($3::sponsor_type, $4::int, $5::text)`,
      [billId, name, sponsorType, sequence, sourcePersonId],
    )
    writes += updated.rowCount ?? 0
  }
  return writes
}

/**
 * Upsert the official a sponsor names, keyed on LegiScan's `people_id`.
 *
 * `getBill` hands us a full bio block per sponsor — party, district, capitol phone,
 * capitol address, website — which is exactly what the brief expected a separate
 * `getPerson` call to provide. Seeding the CRM from the payload we already hold saves
 * one query per legislator against a metered API.
 */
async function upsertOfficial(
  db: PoolClient,
  peopleId: string,
  sponsor: Record<string, unknown>,
): Promise<number> {
  const fullName = str(sponsor.name)?.trim()
  if (!fullName) return 0

  const bio = obj(sponsor.bio)
  const social = obj(bio?.social)

  const values = [
    fullName,
    toOfficialRole(str(sponsor.role), num(sponsor.role_id)),
    str(sponsor.party)?.trim() || null,
    str(sponsor.district)?.trim() || null, // "HD-008" / "SD-012"
    str(social?.email) || null, // LegiScan usually sends "" here
    str(social?.capitol_phone) || str(social?.district_phone) || null,
    // `webmail` is the member's contact form; `website` is their public page.
    str(social?.webmail) || str(social?.website) || null,
    capitolAddress(bio),
  ]

  const key = JSON.stringify({ [SOURCE]: peopleId })
  const { rows: found } = await db.query<{ id: string }>(
    `select id from official where source_person_ids @> $1::jsonb limit 1`,
    [key],
  )
  const existing = found[0]

  if (!existing) {
    await db.query(
      `insert into official
         (source_person_ids, full_name, role, party, district, email, phone, web_form_url, office_address)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [key, ...values],
    )
    return 1
  }

  // Identical payload → 0 rows updated, and the updated_at trigger never fires.
  // source_person_ids is deliberately not in the SET list: ITLK-7 may have merged a
  // second source's id into it, and a re-poll must not clobber that.
  const { rowCount } = await db.query(
    `update official set
       full_name = $2, role = $3, party = $4, district = $5,
       email = $6, phone = $7, web_form_url = $8, office_address = $9
     where id = $1
       and (full_name, role, party, district, email, phone, web_form_url, office_address)
           is distinct from
           ($2::text, $3::official_role, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text)`,
    [existing.id, ...values],
  )
  return rowCount ?? 0
}

/**
 * The bill's pending committee. LegiScan gives no membership roster, so these rows are
 * the committee's identity only — enough for ITLK-9's CRM to name it, and it costs no
 * extra query because it rides along on every getBill.
 */
async function writeCommittee(
  db: PoolClient,
  committee: Record<string, unknown> | null,
): Promise<number> {
  const committeeId = num(committee?.committee_id)
  const name = str(committee?.name)?.trim()
  if (!committeeId || !name) return 0

  const { rowCount } = await db.query(
    `insert into committee (source, source_body_id, name, classification, jurisdiction)
     values ($1,$2,$3,$4,$5)
     on conflict (source, source_body_id) do update set
       name = excluded.name, classification = excluded.classification
     where committee.name is distinct from excluded.name
        or committee.classification is distinct from excluded.classification`,
    [SOURCE, String(committeeId), name, str(committee?.chamber), JURISDICTION],
  )
  return rowCount ?? 0
}

// ---------------------------------------------------------------------------
// shaping helpers
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) return Number.parseInt(value, 10)
  return null
}

function arr(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? (value.filter((v) => v && typeof v === 'object') as Array<Record<string, unknown>>)
    : []
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** LegiScan dates are already bare calendar days ("2025-01-09"). */
function toDate(value: string | null): string | null {
  if (!value) return null
  const day = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

/** Progress event 1 is Introduced; fall back to the earliest history row. */
function introducedDate(
  progress: Array<Record<string, unknown>>,
  history: Array<Record<string, unknown>>,
): string | null {
  const introduced = progress.find((p) => num(p.event) === 1)
  if (introduced) return toDate(str(introduced.date))
  const dates = history.map((h) => toDate(str(h.date))).filter((d): d is string => d !== null)
  return dates.length > 0 ? dates.sort()[0]! : null
}

/** The bill's most recent history row, by date then by position. */
function latestAction(
  history: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  return history
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => toDate(str(row.date)) !== null)
    .sort((a, b) => {
      const byDate = Date.parse(str(a.row.date)!) - Date.parse(str(b.row.date)!)
      return byDate !== 0 ? byDate : a.index - b.index
    })
    .pop()?.row
}

/**
 * The newest bill text. v1 stores links, it does not parse documents — which is also
 * why `getBillText` is never called: `texts[].state_link` is the document, on ILGA.
 */
function fullTextUrl(payload: Record<string, unknown>): string | null {
  const texts = arr(payload.texts)
  if (texts.length === 0) return null
  const newest = [...texts].sort((a, b) => (str(a.date) ?? '').localeCompare(str(b.date) ?? '')).pop()
  return str(newest?.state_link) ?? str(newest?.url)
}

/** Springfield office, from the sponsor's bio block. */
function capitolAddress(bio: Record<string, unknown> | null): string | null {
  const address = obj(bio?.capitol_address)
  if (!address) return null
  const street = str(address.address1)?.trim()
  if (!street) return null
  const city = str(address.city)?.trim()
  const state = str(address.state)?.trim()
  const zip = str(address.zip)?.trim()
  const tail = [city, state].filter(Boolean).join(', ')
  return [street, tail, zip].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}
