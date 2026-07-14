import { signalForStatus, type BillStatus, type Signal } from '@interlock/shared'
import { db } from '../../utils/db'

/**
 * The tracked-bill list (ITLK-8): what the user has taken a position on, with
 * enough bill state to render a row — signal, last action, unread alert count.
 * ITLK-12's dashboard summarizes this; ITLK-11's bill screens link into it.
 */

export interface TrackedBillRow {
  id: string
  billId: string
  position: string
  priority: number
  notes: string | null
  alertChannel: string
  identifier: string
  title: string
  status: BillStatus
  signal: Signal
  jurisdiction: string
  lastActionText: string | null
  lastActionDate: string | null
  unreadAlerts: number
  trackedAt: string
}

export default defineEventHandler(async (): Promise<TrackedBillRow[]> => {
  const { rows } = await db().query<{
    id: string
    bill_id: string
    position: string
    priority: number
    notes: string | null
    alert_channel: string
    identifier: string
    title: string
    status: BillStatus
    jurisdiction: string
    last_action_text: string | null
    last_action_date: string | null
    unread_alerts: string
    created_at: string
  }>(
    `select tb.id, tb.bill_id, tb.position, tb.priority, tb.notes, tb.alert_channel,
            b.identifier, b.title, b.status, b.jurisdiction,
            b.last_action_text, b.last_action_date::text, tb.created_at,
            count(a.id) filter (where a.read_at is null) as unread_alerts
     from tracked_bill tb
     join bill b on b.id = tb.bill_id
     left join alert a on a.bill_id = tb.bill_id
     group by tb.id, b.id
     order by tb.priority desc, b.last_action_date desc nulls last`,
  )

  return rows.map((row) => ({
    id: row.id,
    billId: row.bill_id,
    position: row.position,
    priority: row.priority,
    notes: row.notes,
    alertChannel: row.alert_channel,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    signal: signalForStatus(row.status),
    jurisdiction: row.jurisdiction,
    lastActionText: row.last_action_text,
    lastActionDate: row.last_action_date,
    unreadAlerts: Number(row.unread_alerts),
    trackedAt: new Date(row.created_at).toISOString(),
  }))
})
