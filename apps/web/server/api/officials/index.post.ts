import { OFFICIAL_ROLES, ORG_TYPES } from '@interlock/shared'
import { db } from '../../utils/db'
import { parseOfficialFields } from '../../utils/officials'

/**
 * Add a contact by hand (ITLK-9, extended for organizations in ITLK-21).
 *
 * Two shapes wear this one route, told apart by `contactType`:
 *
 *   - A **person** — the original case. The approved federal variance lives here: a letter
 *     to a US senator the CRM cannot name is a letter that cannot be logged, so `us_rep` /
 *     `us_sen` / `other` are real roles. A person may also carry an `orgId` — the org they
 *     staff (a named contact *at* CDOT).
 *
 *   - An **organization** (CMAP, CDOT, a community group) — a correspondence target that is
 *     not a person. It has an `orgType` instead of a role, an optional `department`, and no
 *     seat (no ward/district/party). Letters address it exactly like a person, via
 *     `letter_official`.
 *
 * `source_person_ids` is left null on both, and that null is load-bearing: it is what tells
 * every ingest upsert this row is not theirs to touch. An org can therefore never be
 * clobbered by a poll — no ingest ever looks a row up by anything but a source person id.
 *
 * POST /api/officials  { contactType?, fullName, role?|orgType?, department?, orgId?, ... }
 */

export interface OfficialCreated {
  id: string
}

export default defineEventHandler(async (event): Promise<OfficialCreated> => {
  const body = await readBody<Record<string, unknown>>(event)

  const fullName = String(body?.fullName ?? '').trim()
  if (!fullName) {
    throw createError({ statusCode: 400, statusMessage: 'fullName is required' })
  }

  const contactType = body?.contactType == null ? 'person' : String(body.contactType)
  if (contactType !== 'person' && contactType !== 'org') {
    throw createError({ statusCode: 400, statusMessage: "contactType must be 'person' or 'org'" })
  }

  const fields = parseOfficialFields(body)
  const pool = db()

  if (contactType === 'org') {
    const orgType = String(body?.orgType ?? '')
    if (!(ORG_TYPES as readonly string[]).includes(orgType)) {
      throw createError({
        statusCode: 400,
        statusMessage: `orgType must be one of: ${ORG_TYPES.join(', ')}`,
      })
    }

    // An org is seatless: role, ward, district, party and an affiliation are all a person's
    // fields, and the check constraint would reject them anyway. Ignore rather than error —
    // the form doesn't offer them, so their presence would only ever be a stale default.
    const { rows } = await pool.query<{ id: string }>(
      `insert into official
         (source_person_ids, contact_type, full_name, org_type, department,
          email, phone, web_form_url, office_address, relationship_notes, active)
       values (null, 'org', $1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        fullName,
        orgType,
        fields.department,
        fields.email,
        fields.phone,
        fields.webFormUrl,
        fields.officeAddress,
        fields.relationshipNotes,
        body?.active === false ? false : true,
      ],
    )
    return { id: rows[0]!.id }
  }

  // Person.
  const role = String(body?.role ?? '')
  if (!(OFFICIAL_ROLES as readonly string[]).includes(role)) {
    throw createError({
      statusCode: 400,
      statusMessage: `role must be one of: ${OFFICIAL_ROLES.join(', ')}`,
    })
  }

  // An affiliation must point at an actual organization, not a person and not a stranger.
  if (fields.orgId) {
    await assertIsOrg(pool, fields.orgId)
  }

  const { rows } = await pool.query<{ id: string }>(
    `insert into official
       (source_person_ids, contact_type, full_name, role, party, ward, district,
        email, phone, web_form_url, office_address, relationship_notes, org_id, active)
     values (null, 'person', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning id`,
    [
      fullName,
      role,
      fields.party,
      fields.ward,
      fields.district,
      fields.email,
      fields.phone,
      fields.webFormUrl,
      fields.officeAddress,
      fields.relationshipNotes,
      fields.orgId,
      body?.active === false ? false : true,
    ],
  )

  return { id: rows[0]!.id }
})

/** A person's `orgId` must resolve to an existing `contact_type = 'org'` row. */
async function assertIsOrg(pool: ReturnType<typeof db>, orgId: string): Promise<void> {
  let ok = false
  try {
    const { rows } = await pool.query<{ contact_type: string }>(
      `select contact_type from official where id = $1`,
      [orgId],
    )
    ok = rows[0]?.contact_type === 'org'
  } catch {
    ok = false // a non-uuid orgId is a bad affiliation, not a 500.
  }
  if (!ok) {
    throw createError({ statusCode: 400, statusMessage: 'orgId must be an existing organization' })
  }
}
