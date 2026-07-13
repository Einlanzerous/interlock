import { db } from '../../utils/db'

/**
 * Official lookup, for the review queue's "it's none of these" case (ITLK-7).
 *
 * The candidate list a review row ships with only contains people whose *name* already
 * resembles the sponsor's. When it doesn't — a nickname, a married name, a source that
 * spelled it badly — the reviewer still needs to reach the right person, so this searches
 * the whole roster.
 *
 * ITLK-9 owns the Officials CRM proper; this is the slice the review queue needs.
 */

export interface OfficialSummary {
  id: string
  fullName: string
  role: string
  party: string | null
  ward: number | null
  district: string | null
  active: boolean
}

export default defineEventHandler(async (event): Promise<OfficialSummary[]> => {
  const q = String(getQuery(event).q ?? '').trim()
  const limit = Math.min(Number(getQuery(event).limit) || 20, 100)

  // normalize_name on both sides, so searching "john smith" finds "Smith, John A."
  const { rows } = await db().query<{
    id: string
    full_name: string
    role: string
    party: string | null
    ward: number | null
    district: string | null
    active: boolean
  }>(
    `select id, full_name, role, party, ward, district, active
     from official
     where $1 = '' or normalize_name(full_name) like '%' || normalize_name($1) || '%'
     order by full_name
     limit $2`,
    [q, limit],
  )

  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    role: row.role,
    party: row.party,
    ward: row.ward,
    district: row.district,
    active: row.active,
  }))
})
