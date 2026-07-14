import { OFFICIAL_ROLES, type OfficialRole } from '@interlock/shared'
import { db } from '../../utils/db'

/**
 * The Officials roster (ITLK-9) — the CRM's list screen, and the same query behind the
 * review queue's "it's none of these" lookup (ITLK-7) and the letter recipient typeahead
 * (ITLK-10). All three want the same thing with different filters: a short list of people.
 *
 * The params are additive. `?q=` alone is the typeahead; `?role=alder&ward=40` alone is
 * the roster filter; together they are the roster's search box.
 *
 * Active-only by default (brief §6): a roster listing every alder who ever served is an
 * archive, not a contact list. `?active=all` opts into the archive.
 */

export interface OfficialSummary {
  id: string
  fullName: string
  role: OfficialRole
  party: string | null
  ward: number | null
  district: string | null
  email: string | null
  phone: string | null
  active: boolean
  /** No source person ids → hand-added (e.g. federal), and no ingest will ever touch it. */
  manual: boolean
}

export default defineEventHandler(async (event): Promise<OfficialSummary[]> => {
  const query = getQuery(event)
  const q = String(query.q ?? '').trim()
  const limit = Math.min(Number(query.limit) || 200, 500)

  const role = query.role ? String(query.role) : null
  if (role && !(OFFICIAL_ROLES as readonly string[]).includes(role)) {
    throw createError({
      statusCode: 400,
      statusMessage: `role must be one of: ${OFFICIAL_ROLES.join(', ')}`,
    })
  }

  // `ward` is an int column. A non-numeric ?ward= is a bad request, not an empty result —
  // quietly returning [] would read as "no alder holds that ward", a different fact.
  let ward: number | null = null
  if (query.ward != null && String(query.ward).trim() !== '') {
    ward = Number(query.ward)
    if (!Number.isInteger(ward)) {
      throw createError({ statusCode: 400, statusMessage: 'ward must be an integer' })
    }
  }

  const district = query.district ? String(query.district).trim() : null

  // Tri-state: active (default) / inactive / all.
  const activeParam = String(query.active ?? 'true')
  const activeFilter: boolean | null =
    activeParam === 'all' ? null : activeParam === 'false' ? false : true

  const { rows } = await db().query<{
    id: string
    full_name: string
    role: OfficialRole
    party: string | null
    ward: number | null
    district: string | null
    email: string | null
    phone: string | null
    active: boolean
    manual: boolean
  }>(
    // normalize_name (migration 0004) on both sides, so searching "john smith" finds
    // "Smith, John A." — the same definition of "the same name" the sponsor matcher uses.
    `select id, full_name, role, party, ward, district, email, phone, active,
            source_person_ids is null as manual
     from official
     where ($1 = '' or normalize_name(full_name) like '%' || normalize_name($1) || '%')
       and ($2::official_role is null or role = $2)
       and ($3::int is null or ward = $3)
       and ($4::text is null or district = $4)
       and ($5::boolean is null or active = $5)
     order by ward nulls last, district nulls last, full_name
     limit $6`,
    [q, role, ward, district, activeFilter, limit],
  )

  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    role: row.role,
    party: row.party,
    ward: row.ward,
    district: row.district,
    email: row.email,
    phone: row.phone,
    active: row.active,
    manual: row.manual,
  }))
})
