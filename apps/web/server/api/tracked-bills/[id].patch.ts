import { ALERT_CHANNELS, TRACKED_POSITIONS } from '@interlock/shared'
import { DatabaseError } from 'pg'
import { db } from '../../utils/db'

/**
 * Adjust a tracking (ITLK-8): position, priority, notes, alert channel.
 * Partial — only the fields present in the body change.
 *
 * PATCH /api/tracked-bills/:id
 */

interface Body {
  position?: string
  priority?: number
  notes?: string | null
  alertChannel?: string
}

export default defineEventHandler(async (event): Promise<{ ok: true }> => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'missing tracked-bill id' })

  const body = (await readBody<Body>(event)) ?? {}

  const sets: string[] = []
  const values: unknown[] = [id]

  if (body.position !== undefined) {
    if (!(TRACKED_POSITIONS as readonly string[]).includes(body.position)) {
      throw createError({
        statusCode: 400,
        statusMessage: `position must be one of: ${TRACKED_POSITIONS.join(', ')}`,
      })
    }
    values.push(body.position)
    sets.push(`position = $${values.length}`)
  }
  if (body.priority !== undefined) {
    if (!Number.isInteger(body.priority) || body.priority < 0 || body.priority > 32767) {
      throw createError({ statusCode: 400, statusMessage: 'priority must be a small non-negative integer' })
    }
    values.push(body.priority)
    sets.push(`priority = $${values.length}`)
  }
  if (body.notes !== undefined) {
    values.push(body.notes?.trim() || null)
    sets.push(`notes = $${values.length}`)
  }
  if (body.alertChannel !== undefined) {
    if (!(ALERT_CHANNELS as readonly string[]).includes(body.alertChannel)) {
      throw createError({
        statusCode: 400,
        statusMessage: `alertChannel must be one of: ${ALERT_CHANNELS.join(', ')}`,
      })
    }
    values.push(body.alertChannel)
    sets.push(`alert_channel = $${values.length}`)
  }

  if (sets.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'nothing to update' })
  }

  try {
    const { rowCount } = await db().query(
      `update tracked_bill set ${sets.join(', ')} where id = $1`,
      values,
    )
    if (!rowCount) throw createError({ statusCode: 404, statusMessage: 'no such tracked bill' })
  } catch (err) {
    if (err instanceof DatabaseError && err.code === '22P02') {
      throw createError({ statusCode: 404, statusMessage: 'no such tracked bill' })
    }
    throw err
  }
  return { ok: true }
})
