import { DatabaseError } from 'pg'
import { db } from '../../utils/db'

/**
 * Delete a letter (ITLK-10).
 *
 * A ledger you cannot correct is a ledger you stop trusting: a draft opened by mistake has
 * to be removable, or it sits in the list forever and the organizer learns to read past it.
 *
 * The `letter_official` / `letter_bill` rows go with it — both FKs are `on delete cascade`
 * (migration 0001), so a delete cannot leave an official's correspondence tab pointing at a
 * letter that no longer exists.
 */

export default defineEventHandler(async (event): Promise<{ id: string; deleted: true }> => {
  const id = getRouterParam(event, 'id')!

  try {
    const { rowCount } = await db().query(`delete from letter where id = $1`, [id])
    if (!rowCount) throw createError({ statusCode: 404, statusMessage: 'no such letter' })
    return { id, deleted: true }
  } catch (err) {
    if (err instanceof DatabaseError && err.code === '22P02') {
      throw createError({ statusCode: 404, statusMessage: 'no such letter' })
    }
    throw err
  }
})
