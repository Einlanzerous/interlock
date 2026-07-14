import { OFFICIAL_ROLES } from '@interlock/shared'
import { db } from '../../utils/db'
import { parseOfficialFields } from '../../utils/officials'

/**
 * Add an official by hand (ITLK-9) — the approved variance from the brief, whose scope
 * fence puts federal out of v1.
 *
 * The organizer writes to their US senator too, and a letter to a person the CRM cannot
 * name is a letter that cannot be logged. So `us_rep` / `us_sen` / `other` are real roles
 * and a hand-added contact is a first-class Official — it just has no source.
 *
 * `source_person_ids` is left null, and that null is load-bearing: it is what tells every
 * ingest upsert this row is not theirs to touch (see normalizePerson, which looks its
 * subjects up by source person id and so can never find one of these).
 *
 * POST /api/officials  { fullName, role, party?, ward?, district?, email?, ... }
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

  const role = String(body?.role ?? '')
  if (!(OFFICIAL_ROLES as readonly string[]).includes(role)) {
    throw createError({
      statusCode: 400,
      statusMessage: `role must be one of: ${OFFICIAL_ROLES.join(', ')}`,
    })
  }

  const fields = parseOfficialFields(body)

  const { rows } = await db().query<{ id: string }>(
    `insert into official
       (source_person_ids, full_name, role, party, ward, district,
        email, phone, web_form_url, office_address, relationship_notes, active)
     values (null, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      body?.active === false ? false : true,
    ],
  )

  return { id: rows[0]!.id }
})
