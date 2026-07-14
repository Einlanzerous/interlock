import { OFFICIAL_ROLES } from '@interlock/shared'
import { DatabaseError } from 'pg'
import { db } from '../../utils/db'
import { INGEST_OWNED_FIELDS, parseOfficialFields } from '../../utils/officials'

/**
 * Edit an official (ITLK-9).
 *
 * Two different things wear this one route, and the difference is `source_person_ids`:
 *
 *   - A **manual** contact (null source_person_ids) is wholly the organizer's. Every
 *     field is editable, because nothing else will ever write to the row.
 *
 *   - A **sourced** official is co-owned with ingest, which rewrites its contact fields on
 *     every poll. Accepting an edit to one of those would be accepting a write we know a
 *     later poll reverts, so it's a 409 with the reason — not a silent no-op, and not a
 *     lie. `relationship_notes`, `party` and `district` stay editable on both, because no
 *     ingest statement names those columns. See utils/officials.ts for the ownership rule.
 *
 * PATCH /api/officials/:id  — only the keys present in the body are written.
 */

export interface OfficialUpdated {
  id: string
  updated: string[]
}

/** Body key → column. Keys absent from the body are left alone (this is a PATCH). */
const COLUMNS: Record<string, string> = {
  fullName: 'full_name',
  role: 'role',
  party: 'party',
  ward: 'ward',
  district: 'district',
  email: 'email',
  phone: 'phone',
  webFormUrl: 'web_form_url',
  officeAddress: 'office_address',
  relationshipNotes: 'relationship_notes',
  active: 'active',
}

export default defineEventHandler(async (event): Promise<OfficialUpdated> => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<Record<string, unknown>>(event)
  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, statusMessage: 'body is required' })
  }

  const keys = Object.keys(body).filter((k) => k in COLUMNS)
  if (keys.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: `nothing to update — send one of: ${Object.keys(COLUMNS).join(', ')}`,
    })
  }

  const pool = db()

  let existing: { manual: boolean } | undefined
  try {
    const { rows } = await pool.query<{ manual: boolean }>(
      `select source_person_ids is null as manual from official where id = $1`,
      [id],
    )
    existing = rows[0]
  } catch (err) {
    if (err instanceof DatabaseError && err.code === '22P02') {
      throw createError({ statusCode: 404, statusMessage: 'no such official' })
    }
    throw err
  }
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'no such official' })

  if (!existing.manual) {
    const owned = keys.filter((k) => (INGEST_OWNED_FIELDS as readonly string[]).includes(k))
    if (owned.length > 0) {
      throw createError({
        statusCode: 409,
        statusMessage:
          `ingest owns ${owned.join(', ')} on a sourced official and rewrites them on the ` +
          `next poll — edit notes, party or district instead, or add a manual contact`,
      })
    }
  }

  // Validated together so a bad ward is a 400 whether or not the row is manual.
  const fields = parseOfficialFields(body)

  if ('role' in body && !(OFFICIAL_ROLES as readonly string[]).includes(String(body.role))) {
    throw createError({
      statusCode: 400,
      statusMessage: `role must be one of: ${OFFICIAL_ROLES.join(', ')}`,
    })
  }
  if ('fullName' in body && !String(body.fullName ?? '').trim()) {
    throw createError({ statusCode: 400, statusMessage: 'fullName cannot be blank' })
  }

  const values: Record<string, unknown> = {
    fullName: String(body.fullName ?? '').trim(),
    role: body.role,
    party: fields.party,
    ward: fields.ward,
    district: fields.district,
    email: fields.email,
    phone: fields.phone,
    webFormUrl: fields.webFormUrl,
    officeAddress: fields.officeAddress,
    relationshipNotes: fields.relationshipNotes,
    active: body.active !== false,
  }

  const sets = keys.map((k, i) => `${COLUMNS[k]} = $${i + 2}`)
  const params = keys.map((k) => values[k])

  await pool.query(`update official set ${sets.join(', ')} where id = $1`, [id, ...params])

  return { id, updated: keys }
})
