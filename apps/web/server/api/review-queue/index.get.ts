import { reviewQueue, reviewQueueCount, type ReviewItem } from '@interlock/db'
import { db, matchThreshold } from '../../utils/db'

/**
 * The tier-3 review queue: every sponsorship the matcher refused to guess at (ITLK-7).
 *
 * Candidates come back with each row, recomputed live against the current `official`
 * table — see `reviewQueue`. The threshold rides along so the UI can show the reviewer
 * where the auto-link bar actually sits rather than hard-coding a number that would
 * silently disagree with the worker's.
 */

export interface ReviewQueueResponse {
  items: ReviewItem[]
  total: number
  threshold: number
}

export default defineEventHandler(async (event): Promise<ReviewQueueResponse> => {
  const query = getQuery(event)
  const limit = Math.min(Number(query.limit) || 50, 200)
  const offset = Math.max(Number(query.offset) || 0, 0)

  const pool = db()
  const [items, total] = await Promise.all([
    reviewQueue(pool, limit, offset),
    reviewQueueCount(pool),
  ])

  return { items, total, threshold: matchThreshold() }
})
