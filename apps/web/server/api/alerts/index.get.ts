import {
  signalForStatus,
  type AlertChangeType,
  type BillStatus,
  type Signal,
} from '@interlock/shared'
import { db } from '../../utils/db'

/**
 * The in-app alert feed (ITLK-8) — the channel that is always on. Newest
 * first; `?unread=1` narrows to what hasn't been seen, which is also the
 * dashboard's (ITLK-12) unread-feed query.
 */

export interface AlertRow {
  id: string
  billId: string
  identifier: string
  title: string
  status: BillStatus
  signal: Signal
  position: string | null
  changeType: AlertChangeType
  payload: Record<string, unknown>
  detectedAt: string
  readAt: string | null
  deliveredChannels: string[]
}

export interface AlertFeedResponse {
  items: AlertRow[]
  unreadTotal: number
}

export default defineEventHandler(async (event): Promise<AlertFeedResponse> => {
  const query = getQuery(event)
  const unreadOnly = query.unread === '1' || query.unread === 'true'
  const limit = Math.min(Number(query.limit) || 50, 200)
  const offset = Math.max(Number(query.offset) || 0, 0)

  const pool = db()
  const [items, unread] = await Promise.all([
    pool.query<{
      id: string
      bill_id: string
      identifier: string
      title: string
      status: BillStatus
      position: string | null
      change_type: AlertChangeType
      payload: Record<string, unknown>
      detected_at: string
      read_at: string | null
      delivered_channels: string[]
    }>(
      `select a.id, a.bill_id, b.identifier, b.title, b.status, tb.position,
              a.change_type, a.payload, a.detected_at, a.read_at, a.delivered_channels
       from alert a
       join bill b on b.id = a.bill_id
       left join tracked_bill tb on tb.bill_id = a.bill_id
       where $1 = false or a.read_at is null
       order by a.detected_at desc
       limit $2 offset $3`,
      [unreadOnly, limit, offset],
    ),
    pool.query<{ n: string }>(`select count(*) as n from alert where read_at is null`),
  ])

  return {
    items: items.rows.map((row) => ({
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
      readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
      deliveredChannels: row.delivered_channels,
    })),
    unreadTotal: Number(unread.rows[0]!.n),
  }
})
