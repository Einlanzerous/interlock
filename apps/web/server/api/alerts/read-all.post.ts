import { db } from '../../utils/db'

/**
 * Clear the unread feed in one motion (ITLK-8). Returns how many were cleared
 * so the UI can say so.
 *
 * POST /api/alerts/read-all
 */

export default defineEventHandler(async (): Promise<{ marked: number }> => {
  const { rowCount } = await db().query(`update alert set read_at = now() where read_at is null`)
  return { marked: rowCount ?? 0 }
})
