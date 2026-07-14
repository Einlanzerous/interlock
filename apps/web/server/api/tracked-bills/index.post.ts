import { ALERT_CHANNELS, TRACKED_POSITIONS } from '@interlock/shared'
import { DatabaseError } from 'pg'
import { db } from '../../utils/db'

/**
 * Track a bill (ITLK-8): the moment a bill matters enough that it must not
 * move silently. One tracking per bill (bill_id UNIQUE) — a position is a
 * stance, not a subscription list.
 *
 * POST /api/tracked-bills
 *   { billId, position, priority?, notes?, alertChannel? }
 */

interface Body {
  billId?: string
  position?: string
  priority?: number
  notes?: string | null
  alertChannel?: string
}

export interface TrackedBillCreated {
  id: string
  billId: string
}

export default defineEventHandler(async (event): Promise<TrackedBillCreated> => {
  const body = await readBody<Body>(event)

  if (!body?.billId) {
    throw createError({ statusCode: 400, statusMessage: 'billId is required' })
  }
  if (!body.position || !(TRACKED_POSITIONS as readonly string[]).includes(body.position)) {
    throw createError({
      statusCode: 400,
      statusMessage: `position must be one of: ${TRACKED_POSITIONS.join(', ')}`,
    })
  }
  const alertChannel = body.alertChannel ?? 'in_app'
  if (!(ALERT_CHANNELS as readonly string[]).includes(alertChannel)) {
    throw createError({
      statusCode: 400,
      statusMessage: `alertChannel must be one of: ${ALERT_CHANNELS.join(', ')}`,
    })
  }
  const priority = body.priority ?? 0
  if (!Number.isInteger(priority) || priority < 0 || priority > 32767) {
    throw createError({ statusCode: 400, statusMessage: 'priority must be a small non-negative integer' })
  }

  try {
    const { rows } = await db().query<{ id: string }>(
      `insert into tracked_bill (bill_id, position, priority, notes, alert_channel)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [body.billId, body.position, priority, body.notes?.trim() || null, alertChannel],
    )
    return { id: rows[0]!.id, billId: body.billId }
  } catch (err) {
    if (err instanceof DatabaseError && err.code === '23505') {
      throw createError({ statusCode: 409, statusMessage: 'bill is already tracked' })
    }
    if (err instanceof DatabaseError && (err.code === '23503' || err.code === '22P02')) {
      // FK violation or a non-uuid id — either way, no such bill.
      throw createError({ statusCode: 404, statusMessage: 'no such bill' })
    }
    throw err
  }
})
