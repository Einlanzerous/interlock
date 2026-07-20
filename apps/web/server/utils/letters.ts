import {
  LETTER_CHANNELS,
  LETTER_DIRECTIONS,
  LETTER_KINDS,
  LETTER_OFFICIAL_ROLES,
  LETTER_STATUSES,
  type LetterChannel,
  type LetterDirection,
  type LetterKind,
  type LetterOfficialRole,
  type LetterStatus,
} from '@interlock/shared'
import type { PoolClient } from 'pg'

/** Shared field handling for the letters ledger (ITLK-10, media pieces ITLK-23). */

export interface LetterOfficialLink {
  officialId: string
  role: LetterOfficialRole
}

export interface LetterFields {
  direction: LetterDirection
  channel: LetterChannel
  status: LetterStatus
  kind: LetterKind
  subject: string
  body: string | null
  url: string | null
  publishedDate: string | null
  sentDate: string | null
  receivedDate: string | null
  followupDate: string | null
  followupDone: boolean
}

function oneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  const v = String(value ?? '')
  if (!(allowed as readonly string[]).includes(v)) {
    throw createError({
      statusCode: 400,
      statusMessage: `${field} must be one of: ${allowed.join(', ')}`,
    })
  }
  return v
}

function text(value: unknown): string | null {
  if (value == null) return null
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

/** A `date` column takes YYYY-MM-DD. Anything else is a 400, not a Postgres error page. */
function day(value: unknown, field: string): string | null {
  const raw = text(value)
  if (raw == null) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw createError({ statusCode: 400, statusMessage: `${field} must be a YYYY-MM-DD date` })
  }
  return raw
}

/**
 * The full field set, for a create. A letter always knows its direction, its channel and
 * what it was about; everything else is optional, because a logged phone call has no
 * subject line, no send date and no body beyond the notes the organizer typed.
 */
export function parseLetter(body: Record<string, unknown> | null): LetterFields {
  const subject = String(body?.subject ?? '').trim()
  if (!subject) {
    throw createError({ statusCode: 400, statusMessage: 'subject is required' })
  }

  const kind: LetterKind = body?.kind == null ? 'correspondence' : oneOf(body.kind, LETTER_KINDS, 'kind')
  const publishedDate = day(body?.publishedDate, 'publishedDate')

  // A publish date is a claim that something ran, so it has no meaning on a plain exchange —
  // matches the letter_published_date_kind check, but as a readable 400 rather than a DB error.
  if (publishedDate && kind === 'correspondence') {
    throw createError({
      statusCode: 400,
      statusMessage: 'publishedDate only applies to a letter to the editor or an op-ed',
    })
  }

  return {
    direction: oneOf(body?.direction, LETTER_DIRECTIONS, 'direction'),
    channel: oneOf(body?.channel, LETTER_CHANNELS, 'channel'),
    status: body?.status == null ? 'draft' : oneOf(body.status, LETTER_STATUSES, 'status'),
    kind,
    subject,
    body: text(body?.body),
    url: text(body?.url),
    publishedDate,
    sentDate: day(body?.sentDate, 'sentDate'),
    receivedDate: day(body?.receivedDate, 'receivedDate'),
    followupDate: day(body?.followupDate, 'followupDate'),
    followupDone: body?.followupDone === true,
  }
}

/** Validate the officials a letter names, and the role each played in it. */
export function parseOfficialLinks(value: unknown): LetterOfficialLink[] {
  if (value == null) return []
  if (!Array.isArray(value)) {
    throw createError({ statusCode: 400, statusMessage: 'officials must be an array' })
  }
  return value.map((entry) => {
    const link = entry as Record<string, unknown>
    const officialId = String(link?.officialId ?? '').trim()
    if (!officialId) {
      throw createError({ statusCode: 400, statusMessage: 'each official needs an officialId' })
    }
    return {
      officialId,
      role: link?.role == null
        ? 'recipient'
        : oneOf(link.role, LETTER_OFFICIAL_ROLES, 'official role'),
    }
  })
}

export function parseBillIds(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value)) {
    throw createError({ statusCode: 400, statusMessage: 'billIds must be an array' })
  }
  return value.map((id) => String(id).trim()).filter(Boolean)
}

/**
 * Rewrite a letter's links to officials and bills.
 *
 * Delete-then-insert rather than a diff: the join rows carry nothing but the link itself
 * (`letter_official` has a role, and that role is part of its primary key), so there is no
 * state to preserve across the rewrite and a diff would only be a slower way to reach the
 * same rows. Runs inside the caller's transaction, so a letter is never briefly linked to
 * nobody.
 */
export async function writeLinks(
  db: PoolClient,
  letterId: string,
  officials: LetterOfficialLink[],
  billIds: string[],
): Promise<void> {
  await db.query(`delete from letter_official where letter_id = $1`, [letterId])
  await db.query(`delete from letter_bill where letter_id = $1`, [letterId])

  for (const { officialId, role } of officials) {
    await db.query(
      `insert into letter_official (letter_id, official_id, role) values ($1, $2, $3)
       on conflict do nothing`,
      [letterId, officialId, role],
    )
  }
  for (const billId of billIds) {
    await db.query(
      `insert into letter_bill (letter_id, bill_id) values ($1, $2) on conflict do nothing`,
      [letterId, billId],
    )
  }
}
