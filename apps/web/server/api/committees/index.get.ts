import { JURISDICTIONS, type Jurisdiction } from '@interlock/shared'
import { db } from '../../utils/db'

/**
 * The committee filter's options (ITLK-11).
 *
 * Only committees that actually **have** a bill are listed. A dropdown of every body eLMS
 * has ever published is a dropdown nobody reads, and every entry in it that matches nothing
 * is an invitation to conclude "there are no bills in Zoning" when the truth is that nothing
 * was ever linked to it. `billCount` is on each row for the same reason: the filter should
 * say what it will do before you use it.
 */

export interface CommitteeOption {
  id: string
  name: string
  jurisdiction: Jurisdiction
  billCount: number
}

export default defineEventHandler(async (event): Promise<CommitteeOption[]> => {
  const jurisdiction = getQuery(event).jurisdiction
    ? String(getQuery(event).jurisdiction)
    : null
  if (jurisdiction && !(JURISDICTIONS as readonly string[]).includes(jurisdiction)) {
    throw createError({
      statusCode: 400,
      statusMessage: `jurisdiction must be one of: ${JURISDICTIONS.join(', ')}`,
    })
  }

  const { rows } = await db().query<{
    id: string
    name: string
    jurisdiction: Jurisdiction
    bill_count: string
  }>(
    `select c.id, c.name, c.jurisdiction, count(b.id) as bill_count
     from committee c
     join bill b on b.committee_id = c.id
     where ($1::jurisdiction is null or c.jurisdiction = $1)
     group by c.id
     order by c.jurisdiction, c.name`,
    [jurisdiction],
  )

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    jurisdiction: row.jurisdiction,
    billCount: Number(row.bill_count),
  }))
})
