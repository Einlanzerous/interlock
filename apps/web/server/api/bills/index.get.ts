import {
  JURISDICTIONS,
  signalForStatus,
  type BillStatus,
  type Jurisdiction,
  type Signal,
} from '@interlock/shared'
import { db } from '../../utils/db'

/**
 * Bill search (ITLK-10's slice — ITLK-11 owns the Bills screens and grows this).
 *
 * Right now this is the typeahead behind "which bill is this letter about?", so it is the
 * search box and nothing else. It is already the *real* search, though: Postgres FTS over
 * `search_tsv` (title weighted A, summary B — migration 0001), because a typeahead that
 * matched differently from the Bills list would be a second, quietly disagreeing definition
 * of "found".
 *
 * `websearch_to_tsquery` rather than `plainto_tsquery`: it takes what a person types
 * ("transit funding", quoted phrases, `-parking`) without throwing on the punctuation.
 */

export interface BillSummary {
  id: string
  identifier: string
  title: string
  status: BillStatus
  signal: Signal
  jurisdiction: Jurisdiction
  session: string | null
  lastActionText: string | null
  lastActionDate: string | null
  /** The stance we hold it with, if it's tracked at all (ITLK-8). */
  position: string | null
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

  const { rows } = await db().query<{
    id: string
    identifier: string
    title: string
    status: BillStatus
    jurisdiction: Jurisdiction
    session: string | null
    last_action_text: string | null
    last_action_date: string | null
    position: string | null
  }>(
    // An identifier is not English, so FTS will never find "HB1234" in a tsvector built by
    // the english dictionary. The organizer types it constantly, so it is matched literally
    // alongside the text search rather than being the one query that mysteriously fails.
    `select b.id, b.identifier, b.title, b.status, b.jurisdiction, b.session,
            b.last_action_text, b.last_action_date::text, tb.position
     from bill b
     left join tracked_bill tb on tb.bill_id = b.id
     where ($1 = ''
            or b.search_tsv @@ websearch_to_tsquery('english', $1)
            or b.identifier ilike '%' || $1 || '%')
       and ($2::jurisdiction is null or b.jurisdiction = $2)
     order by
       case when $1 = '' then 0
            else ts_rank(b.search_tsv, websearch_to_tsquery('english', $1)) end desc,
       b.last_action_date desc nulls last
     limit $3`,
    [q, jurisdiction, limit],
  )

  return rows.map((row) => ({
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    signal: signalForStatus(row.status),
    jurisdiction: row.jurisdiction,
    session: row.session,
    lastActionText: row.last_action_text,
    lastActionDate: row.last_action_date,
    position: row.position,
  }))
})
