import { DatabaseError } from 'pg'
import { db } from '../../../utils/db'

/**
 * Mark one alert read (ITLK-8). Idempotent: a second click keeps the first
 * read_at rather than rewriting history.
 *
 * POST /api/alerts/:id/read
 */

export default defineEventHandler(async (event): Promise<{ readAt: string }> => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'missing alert id' })

  try {
    const { rows } = await db().query<{ read_at: string }>(
      `update alert set read_at = coalesce(read_at, now()) where id = $1 returning read_at`,
      [id],
    )
    if (!rows[0]) throw createError({ statusCode: 404, statusMessage: 'no such alert' })
    return { readAt: new Date(rows[0].read_at).toISOString() }
  } catch (err) {
    if (err instanceof DatabaseError && err.code === '22P02') {
      throw createError({ statusCode: 404, statusMessage: 'no such alert' })
    }
    throw err
  }
})
