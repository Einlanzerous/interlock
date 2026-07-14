import { confirmMatch, createOfficialAndConfirm, ReviewError } from '@interlock/db'
import { db } from '../../../utils/db'

/**
 * The one-click confirm (ITLK-7).
 *
 * Either binds the sponsorship to an Official the reviewer picked, or creates the person
 * first when we don't have them yet. Both paths backfill the source's person id onto the
 * Official, which is the point of the click: the *next* poll of that sponsor resolves at
 * tier 1 and never reaches this queue again.
 *
 * POST /api/review-queue/:sponsorshipId/confirm
 *   { officialId }                                → link to an existing Official
 *   { newOfficial: { fullName, role, ward?, district?, party? } }  → create, then link
 */

interface Body {
  officialId?: string
  newOfficial?: {
    fullName?: string
    role?: string
    ward?: number | null
    district?: string | null
    party?: string | null
  }
}

const ROLES = ['alder', 'state_rep', 'state_sen', 'mayor', 'us_rep', 'us_sen', 'other']

export default defineEventHandler(async (event): Promise<{ officialId: string }> => {
  const sponsorshipId = getRouterParam(event, 'id')
  if (!sponsorshipId) {
    throw createError({ statusCode: 400, statusMessage: 'missing sponsorship id' })
  }

  const body = await readBody<Body>(event)
  const pool = db()

  try {
    if (body?.officialId) {
      await confirmMatch(pool, sponsorshipId, body.officialId)
      return { officialId: body.officialId }
    }

    const draft = body?.newOfficial
    if (!draft?.fullName?.trim()) {
      throw createError({
        statusCode: 400,
        statusMessage: 'provide either officialId or newOfficial.fullName',
      })
    }
    if (!draft.role || !ROLES.includes(draft.role)) {
      throw createError({ statusCode: 400, statusMessage: `role must be one of: ${ROLES.join(', ')}` })
    }

    const officialId = await createOfficialAndConfirm(pool, sponsorshipId, {
      fullName: draft.fullName,
      role: draft.role,
      ward: draft.ward ?? null,
      district: draft.district ?? null,
      party: draft.party ?? null,
    })
    return { officialId }
  } catch (err) {
    // A stale queue — someone confirmed this row in another tab, or the Official is
    // already a sponsor of this bill. That's a 409, not a 500: the request was
    // well-formed, the world just moved.
    if (err instanceof ReviewError) {
      throw createError({ statusCode: 409, statusMessage: err.message })
    }
    throw err
  }
})
