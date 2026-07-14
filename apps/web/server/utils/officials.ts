/**
 * Shared field handling for the Officials CRM (ITLK-9).
 *
 * ---------------------------------------------------------------------------
 * Who owns which column — the rule the whole CRM edit surface hangs off.
 * ---------------------------------------------------------------------------
 * An Official that came from a feed is co-owned: ingest refreshes it on every poll.
 * `normalizePerson` (chi_clerk adapter) updates exactly these columns —
 *
 *     full_name, role, ward, email, phone, web_form_url, office_address, active
 *
 * — and no others. So on a *sourced* official those are ingest's, and a hand-edit to any
 * of them survives only until the next poll. Offering that edit would be offering a lie,
 * so the API refuses it (409) rather than accepting a write it knows will be reverted.
 *
 * The three columns ingest never writes are the organizer's, on every official:
 *
 *     relationship_notes, party, district
 *
 * `relationship_notes` is the one the ticket calls out — "notes survive re-ingest" — and
 * it survives structurally, because no ingest statement names the column. The regression
 * test in officials.test.ts is what keeps that true.
 *
 * A *manual* official (source_person_ids is null) has no ingest to co-own it, so every
 * column is the organizer's.
 */

/** Columns an ingest poll rewrites — hand-edits to these do not survive on a sourced official. */
export const INGEST_OWNED_FIELDS = [
  'fullName',
  'role',
  'ward',
  'email',
  'phone',
  'webFormUrl',
  'officeAddress',
  'active',
] as const

/** Columns no ingest statement writes — always the organizer's, on any official. */
export const HUMAN_OWNED_FIELDS = ['relationshipNotes', 'party', 'district'] as const

export interface OfficialFields {
  party: string | null
  ward: number | null
  district: string | null
  email: string | null
  phone: string | null
  webFormUrl: string | null
  officeAddress: string | null
  relationshipNotes: string | null
}

/** Empty string and whitespace mean "not set", not "set to blank". */
function text(value: unknown): string | null {
  if (value == null) return null
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

export function parseOfficialFields(body: Record<string, unknown> | null): OfficialFields {
  let ward: number | null = null
  const rawWard = body?.ward
  if (rawWard != null && String(rawWard).trim() !== '') {
    ward = Number(rawWard)
    if (!Number.isInteger(ward) || ward < 0) {
      throw createError({ statusCode: 400, statusMessage: 'ward must be a non-negative integer' })
    }
  }

  return {
    party: text(body?.party),
    ward,
    district: text(body?.district),
    email: text(body?.email),
    phone: text(body?.phone),
    webFormUrl: text(body?.webFormUrl),
    officeAddress: text(body?.officeAddress),
    relationshipNotes: text(body?.relationshipNotes),
  }
}
