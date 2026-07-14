import { DatabaseError } from 'pg'
import { db } from '../../utils/db'

/**
 * Untrack a bill (ITLK-8). The bill and its history stay; only the stance and
 * its future alerts go. Past alerts survive on purpose — they were true when
 * they fired, and the feed is a record, not a subscription.
 *
 * DELETE /api/tracked-bills/:id
 */

export default defineEventHandler(async (event): Promise<{ ok: true }> => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'missing tracked-bill id' })

  try {
    const { rowCount } = await db().query(`delete from tracked_bill where id = $1`, [id])
    if (!rowCount) throw createError({ statusCode: 404, statusMessage: 'no such tracked bill' })
  } catch (err) {
    if (err instanceof DatabaseError && err.code === '22P02') {
      throw createError({ statusCode: 404, statusMessage: 'no such tracked bill' })
    }
    throw err
  }
  return { ok: true }
})
