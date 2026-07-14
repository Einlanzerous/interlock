import {
  signalForStatus,
  TRACKED_POSITIONS,
  type AlertChangeType,
  type BillStatus,
  type Signal,
  type TrackedPosition,
} from '@interlock/shared'
import { db } from '../../utils/db'

/**
 * The morning glance (ITLK-12, brief §6): everything that moved, and everything due.
 *
 * One endpoint rather than three, for the same reason the CRM detail is one fetch: the three
 * panels are answering one question ("what needs me today?"), and three round trips would let
 * them disagree about when *today* is — a follow-up counted as due in one query and not-due
 * in the next, at a midnight boundary or a slow request. They are read together, so they are
 * read at one instant.
 *
 * The panels reuse the same canonical facts the other screens do — the signal is derived from
 * `bill.status` here exactly as it is everywhere else — so the dashboard cannot quietly
 * disagree with the bill you land on when you click through.
 */

export interface DashboardAlert {
  id: string
  billId: string
  identifier: string
  title: string
  status: BillStatus
  signal: Signal
  position: TrackedPosition | null
  changeType: AlertChangeType
  payload: Record<string, unknown>
  detectedAt: string
}

export interface DashboardFollowup {
  letterId: string
  subject: string
  direction: string
  channel: string
  status: string
  followupDate: string
  /** Due today vs. already past — the panel colors them differently, and it matters. */
  overdue: boolean
  officials: Array<{ id: string; fullName: string }>
}

export interface DashboardResponse {
  alerts: DashboardAlert[]
  unreadTotal: number
  followups: DashboardFollowup[]
  /** Tracked bills by stance. Every position is present, including the zeroes. */
  tracked: Record<TrackedPosition, number>
  trackedTotal: number
}

export default defineEventHandler(async (event): Promise<DashboardResponse> => {
  const limit = Math.min(Number(getQuery(event).limit) || 20, 100)
  const pool = db()

  const [alerts, unread, followups, tracked] = await Promise.all([
    pool.query<{
      id: string
      bill_id: string
      identifier: string
      title: string
      status: BillStatus
      position: TrackedPosition | null
      change_type: AlertChangeType
      payload: Record<string, unknown>
      detected_at: string
    }>(
      `select a.id, a.bill_id, b.identifier, b.title, b.status, tb.position,
              a.change_type, a.payload, a.detected_at
       from alert a
       join bill b on b.id = a.bill_id
       left join tracked_bill tb on tb.bill_id = a.bill_id
       where a.read_at is null
       order by a.detected_at desc
       limit $1`,
      [limit],
    ),

    pool.query<{ n: string }>(`select count(*) as n from alert where read_at is null`),

    // Due = on or before today, and not done. `current_date` is the database's day, which is
    // the same day the ledger's own overdue styling uses — so a follow-up cannot be "due"
    // here and "not due yet" there.
    pool.query<{
      letter_id: string
      subject: string
      direction: string
      channel: string
      status: string
      followup_date: string
      overdue: boolean
      officials: Array<{ id: string; full_name: string }> | null
    }>(
      `select l.id as letter_id, l.subject, l.direction, l.channel, l.status,
              l.followup_date::text, l.followup_date < current_date as overdue,
              (select json_agg(json_build_object('id', o.id, 'full_name', o.full_name)
                               order by o.full_name)
               from letter_official lo join official o on o.id = lo.official_id
               where lo.letter_id = l.id) as officials
       from letter l
       where l.followup_date is not null
         and not l.followup_done
         and l.followup_date <= current_date
       order by l.followup_date, l.created_at`,
    ),

    pool.query<{ position: TrackedPosition; n: string }>(
      `select position, count(*) as n from tracked_bill group by position`,
    ),
  ])

  // Start from every position at zero. A stance with no bills is a real answer — "nothing
  // opposed" — and a tile that vanishes when its count hits zero is a tile you can't trust to
  // still be there tomorrow.
  const counts = Object.fromEntries(
    TRACKED_POSITIONS.map((p) => [p, 0]),
  ) as Record<TrackedPosition, number>
  for (const row of tracked.rows) counts[row.position] = Number(row.n)

  return {
    alerts: alerts.rows.map((row) => ({
      id: row.id,
      billId: row.bill_id,
      identifier: row.identifier,
      title: row.title,
      status: row.status,
      signal: signalForStatus(row.status),
      position: row.position,
      changeType: row.change_type,
      payload: row.payload,
      detectedAt: new Date(row.detected_at).toISOString(),
    })),
    unreadTotal: Number(unread.rows[0]!.n),
    followups: followups.rows.map((row) => ({
      letterId: row.letter_id,
      subject: row.subject,
      direction: row.direction,
      channel: row.channel,
      status: row.status,
      followupDate: row.followup_date,
      overdue: row.overdue,
      officials: (row.officials ?? []).map((o) => ({ id: o.id, fullName: o.full_name })),
    })),
    tracked: counts,
    trackedTotal: Object.values(counts).reduce((a, b) => a + b, 0),
  }
})
