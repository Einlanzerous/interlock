import {
  LETTER_DIRECTIONS,
  LETTER_STATUSES,
  signalForStatus,
  type BillStatus,
  type LetterChannel,
  type LetterDirection,
  type LetterStatus,
  type Signal,
} from '@interlock/shared'
import { DatabaseError } from 'pg'
import { db } from '../../utils/db'

/**
 * The letters ledger (ITLK-10, brief §6 / user flow B) — every letter, call, email and
 * web-form submission, sent or received, in one list.
 *
 * Filterable by the two things the organizer actually asks: *what have we said to this
 * person* (`?officialId=`) and *what have we said about this bill* (`?billId=`). Both are
 * EXISTS subqueries rather than joins, so filtering by an official can't multiply a letter
 * that names three of them into three rows.
 *
 * Each row ships its own officials and bills — the ledger shows them inline, and N+1 round
 * trips for a list view is a way to make a fast query slow.
 */

export interface LedgerOfficial {
  id: string
  fullName: string
  role: string
}

export interface LedgerBill {
  id: string
  identifier: string
  signal: Signal
}

export interface LetterRow {
  id: string
  direction: LetterDirection
  channel: LetterChannel
  status: LetterStatus
  subject: string
  body: string | null
  sentDate: string | null
  receivedDate: string | null
  followupDate: string | null
  followupDone: boolean
  officials: LedgerOfficial[]
  bills: LedgerBill[]
  createdAt: string
}

export interface LedgerResponse {
  items: LetterRow[]
  total: number
  /** Follow-ups due on or before today and not yet done — the dashboard's number (ITLK-12). */
  followupsDue: number
}

interface Row {
  id: string
  direction: LetterDirection
  channel: LetterChannel
  status: LetterStatus
  subject: string
  body: string | null
  sent_date: string | null
  received_date: string | null
  followup_date: string | null
  followup_done: boolean
  officials: Array<{ id: string; full_name: string; role: string }> | null
  bills: Array<{ id: string; identifier: string; status: BillStatus }> | null
  created_at: string
}

export default defineEventHandler(async (event): Promise<LedgerResponse> => {
  const query = getQuery(event)

  const officialId = query.officialId ? String(query.officialId) : null
  const billId = query.billId ? String(query.billId) : null

  const direction = query.direction ? String(query.direction) : null
  if (direction && !(LETTER_DIRECTIONS as readonly string[]).includes(direction)) {
    throw createError({
      statusCode: 400,
      statusMessage: `direction must be one of: ${LETTER_DIRECTIONS.join(', ')}`,
    })
  }

  const status = query.status ? String(query.status) : null
  if (status && !(LETTER_STATUSES as readonly string[]).includes(status)) {
    throw createError({
      statusCode: 400,
      statusMessage: `status must be one of: ${LETTER_STATUSES.join(', ')}`,
    })
  }

  const limit = Math.min(Number(query.limit) || 100, 500)
  const offset = Math.max(Number(query.offset) || 0, 0)

  const where = `
    ($1::uuid is null or exists (
       select 1 from letter_official lo where lo.letter_id = l.id and lo.official_id = $1))
    and ($2::uuid is null or exists (
       select 1 from letter_bill lb where lb.letter_id = l.id and lb.bill_id = $2))
    and ($3::letter_direction is null or l.direction = $3)
    and ($4::letter_status is null or l.status = $4)`

  const pool = db()

  try {
    const [items, total, due] = await Promise.all([
      pool.query<Row>(
        // Ordered by when the exchange happened, not when the row was made: a call logged
        // today about a letter sent last month belongs where its date puts it. A draft has
        // neither date, so it falls back to created_at rather than sinking to the bottom.
        `select l.id, l.direction, l.channel, l.status, l.subject, l.body,
                l.sent_date::text, l.received_date::text,
                l.followup_date::text, l.followup_done, l.created_at,
                (select json_agg(json_build_object('id', o.id, 'full_name', o.full_name, 'role', lo.role)
                                 order by lo.role, o.full_name)
                 from letter_official lo join official o on o.id = lo.official_id
                 where lo.letter_id = l.id) as officials,
                (select json_agg(json_build_object('id', b.id, 'identifier', b.identifier, 'status', b.status)
                                 order by b.identifier)
                 from letter_bill lb join bill b on b.id = lb.bill_id
                 where lb.letter_id = l.id) as bills
         from letter l
         where ${where}
         order by coalesce(l.sent_date, l.received_date, l.created_at::date) desc,
                  l.created_at desc
         limit $5 offset $6`,
        [officialId, billId, direction, status, limit, offset],
      ),
      pool.query<{ n: string }>(
        `select count(*) as n from letter l where ${where}`,
        [officialId, billId, direction, status],
      ),
      pool.query<{ n: string }>(
        `select count(*) as n from letter
         where followup_date is not null and not followup_done and followup_date <= current_date`,
      ),
    ])

    return {
      items: items.rows.map((row) => ({
        id: row.id,
        direction: row.direction,
        channel: row.channel,
        status: row.status,
        subject: row.subject,
        body: row.body,
        sentDate: row.sent_date,
        receivedDate: row.received_date,
        followupDate: row.followup_date,
        followupDone: row.followup_done,
        officials: (row.officials ?? []).map((o) => ({
          id: o.id,
          fullName: o.full_name,
          role: o.role,
        })),
        // The signal is derived here, never stored — same rule as everywhere else.
        bills: (row.bills ?? []).map((b) => ({
          id: b.id,
          identifier: b.identifier,
          signal: signalForStatus(b.status),
        })),
        createdAt: new Date(row.created_at).toISOString(),
      })),
      total: Number(total.rows[0]!.n),
      followupsDue: Number(due.rows[0]!.n),
    }
  } catch (err) {
    // A non-uuid ?officialId= / ?billId= is a bad filter, not a server error.
    if (err instanceof DatabaseError && err.code === '22P02') {
      throw createError({ statusCode: 400, statusMessage: 'officialId and billId must be uuids' })
    }
    throw err
  }
})
