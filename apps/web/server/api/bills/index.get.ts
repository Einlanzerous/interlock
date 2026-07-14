import {
  BILL_STATUSES,
  JURISDICTIONS,
  signalForStatus,
  type BillStatus,
  type Jurisdiction,
  type Signal,
} from '@interlock/shared'
import { DatabaseError } from 'pg'
import { db } from '../../utils/db'

/**
 * Bill search (ITLK-11, brief §6 / user flow A) — one box across both governments.
 *
 * Postgres FTS over `search_tsv` (title weighted A, summary B — migration 0001), so a word
 * from a bill's title finds it whichever source it came from. This is also the compose
 * drawer's typeahead (ITLK-10): a typeahead that matched differently from the Bills list
 * would be a second, quietly disagreeing definition of "found".
 *
 * `websearch_to_tsquery` rather than `plainto_tsquery`: it takes what a person actually types
 * — quoted phrases, `-parking` to exclude — and does not throw on stray punctuation.
 *
 * Facets: source, canonical status, committee. All narrow, none of them search.
 */

export interface BillSummary {
  id: string
  identifier: string
  title: string
  status: BillStatus
  signal: Signal
  jurisdiction: Jurisdiction
  session: string | null
  committee: { id: string; name: string } | null
  lastActionText: string | null
  lastActionDate: string | null
  /** The stance we hold it with, if it's tracked at all (ITLK-8). */
  position: string | null
  unreadAlerts: number
}

export default defineEventHandler(async (event): Promise<BillSummary[]> => {
  const query = getQuery(event)
  const q = String(query.q ?? '').trim()
  const limit = Math.min(Number(query.limit) || 50, 200)

  const jurisdiction = query.jurisdiction ? String(query.jurisdiction) : null
  if (jurisdiction && !(JURISDICTIONS as readonly string[]).includes(jurisdiction)) {
    throw createError({
      statusCode: 400,
      statusMessage: `jurisdiction must be one of: ${JURISDICTIONS.join(', ')}`,
    })
  }

  const status = query.status ? String(query.status) : null
  if (status && !(BILL_STATUSES as readonly string[]).includes(status)) {
    throw createError({
      statusCode: 400,
      statusMessage: `status must be one of: ${BILL_STATUSES.join(', ')}`,
    })
  }

  const committeeId = query.committeeId ? String(query.committeeId) : null
  const trackedOnly = query.tracked === '1' || query.tracked === 'true'

  try {
    const { rows } = await db().query<{
      id: string
      identifier: string
      title: string
      status: BillStatus
      jurisdiction: Jurisdiction
      session: string | null
      committee_id: string | null
      committee_name: string | null
      last_action_text: string | null
      last_action_date: string | null
      position: string | null
      unread_alerts: string
    }>(
      // An identifier is not English: FTS will never find "HB1234" in a tsvector built by the
      // english dictionary, and the organizer types identifiers constantly. So it is matched
      // literally alongside the text search, rather than being the one query that
      // mysteriously returns nothing.
      `select b.id, b.identifier, b.title, b.status, b.jurisdiction, b.session,
              b.committee_id, c.name as committee_name,
              b.last_action_text, b.last_action_date::text, tb.position,
              (select count(*) from alert a where a.bill_id = b.id and a.read_at is null)
                as unread_alerts
       from bill b
       left join committee c on c.id = b.committee_id
       left join tracked_bill tb on tb.bill_id = b.id
       where ($1 = ''
              or b.search_tsv @@ websearch_to_tsquery('english', $1)
              or b.identifier ilike '%' || $1 || '%')
         and ($2::jurisdiction is null or b.jurisdiction = $2)
         and ($3::bill_status is null or b.status = $3)
         and ($4::uuid is null or b.committee_id = $4)
         and ($5 = false or tb.id is not null)
       order by
         case when $1 = '' then 0
              else ts_rank(b.search_tsv, websearch_to_tsquery('english', $1)) end desc,
         b.last_action_date desc nulls last,
         b.identifier
       limit $6`,
      [q, jurisdiction, status, committeeId, trackedOnly, limit],
    )

    return rows.map((row) => ({
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      status: row.status,
      signal: signalForStatus(row.status),
      jurisdiction: row.jurisdiction,
      session: row.session,
      committee:
        row.committee_id && row.committee_name
          ? { id: row.committee_id, name: row.committee_name }
          : null,
      lastActionText: row.last_action_text,
      lastActionDate: row.last_action_date,
      position: row.position,
      unreadAlerts: Number(row.unread_alerts),
    }))
  } catch (err) {
    if (err instanceof DatabaseError && err.code === '22P02') {
      throw createError({ statusCode: 400, statusMessage: 'committeeId must be a uuid' })
    }
    throw err
  }
})
