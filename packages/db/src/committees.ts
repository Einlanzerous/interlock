import type { Db } from './matching'

/**
 * Bill → Committee resolution (ITLK-11).
 *
 * The bill carries `source_committee`: the committee the source *said* has it, verbatim,
 * captured at ingest by the only stage allowed to read a payload. This turns that claim
 * into a `committee_id`, or into nothing.
 *
 * It is a separate, re-runnable stage rather than a lookup inside the adapter for the same
 * reason ITLK-7's matcher is: **the answer depends on the state of another table, not on the
 * bill.** A Chicago matter is routinely normalized before the body defining its committee has
 * ever been fetched. Resolve at ingest and that bill's committee_id is null forever — the
 * bill's watermark short-circuits the next poll, so the adapter never looks at it again.
 * Resolve here, on every poll, and the link appears the moment the committee does.
 *
 * Matching is by **name within a jurisdiction**, because a name is all eLMS gives us — its
 * `committeReferral` is a bare string with no body id attached. Case-insensitive and
 * whitespace-trimmed; nothing fuzzier. A committee is not a person: there is no nickname
 * problem, no married name, no middle initial, and two committees with names close enough to
 * confuse a trigram are two different committees. If the name doesn't match, the answer is
 * "we don't know", and `committee_id` stays null — the same discipline as never silently
 * guessing an identity.
 */

export interface LinkCommitteeResult {
  /** The committee the bill now points at, or null if the claim resolved to nothing. */
  committeeId: string | null
  /** True when this call changed the link (so callers can stay quiet when nothing moved). */
  changed: boolean
}

/**
 * Resolve one bill's `source_committee` to a `committee_id`.
 *
 * Idempotent: a bill whose link is already correct is not rewritten, so the `updated_at`
 * trigger doesn't fire and a re-poll of an unchanged bill stays a genuine no-op.
 */
export async function linkCommittee(db: Db, billId: string): Promise<LinkCommitteeResult> {
  const { rows } = await db.query<{
    source_committee: string | null
    jurisdiction: string
    committee_id: string | null
  }>(
    `select source_committee, jurisdiction, committee_id from bill where id = $1`,
    [billId],
  )
  const bill = rows[0]
  if (!bill) return { committeeId: null, changed: false }

  let resolved: string | null = null

  const claim = bill.source_committee?.trim()
  if (claim) {
    const { rows: found } = await db.query<{ id: string }>(
      `select id from committee
       where jurisdiction = $1 and lower(name) = lower($2)
       order by id
       limit 1`,
      [bill.jurisdiction, claim],
    )
    resolved = found[0]?.id ?? null
  }

  if (resolved === bill.committee_id) return { committeeId: resolved, changed: false }

  await db.query(`update bill set committee_id = $2 where id = $1`, [billId, resolved])
  return { committeeId: resolved, changed: true }
}
