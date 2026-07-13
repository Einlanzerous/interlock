import type { Fetcher, FetchPage, Source, SourceRecordInput } from '@interlock/shared'
import type { LegiScanSession, MasterListEntry } from './client'
import { BudgetExhaustedError, type QueryBudget } from './budget'

/** The slice of the LegiScan client this fetcher needs (LegiScanClient satisfies it). */
export interface LegiScanApi {
  getSessionList(): Promise<LegiScanSession[]>
  getMasterListRaw(sessionId: number): Promise<MasterListEntry[]>
  getBill(billId: number): Promise<Record<string, unknown>>
}

/**
 * Change hashes we have already staged, keyed by `source_id` — the seam's own
 * `source_record` table, read through a port so the fetcher never touches SQL
 * (docs/fetcher-seam.md). The worker wires `readChangeHashes` into this.
 */
export type KnownHashes = () => Promise<Map<string, string>>

/**
 * The LegiScan fetcher for the Illinois General Assembly (ITLK-6).
 *
 * ## Why this fetcher has no cursor
 *
 * The eLMS fetcher walks a watermark because eLMS has no change primitive: the only
 * way to find what moved is to page newest-first and stop where you've been. LegiScan
 * hands us the opposite — `getMasterListRaw` returns a `change_hash` for every bill in
 * the session in a **single query** (12,022 bills for the 104th GA). Change detection
 * is therefore a set difference, not a walk, and a positional cursor would be a second,
 * weaker copy of state we already hold: the `change_hash` on the `source_record` rows
 * we have staged.
 *
 * So `poll()` ignores its cursor and returns `nextCursor: null`. That is a deliberate
 * use of the seam contract, not a gap in it — and it buys three things:
 *
 *   - **Crash safety for free.** A bill is "done" only once its `source_record` row is
 *     committed. Die mid-poll and the next one re-detects exactly what never landed.
 *   - **A bounded run.** A null cursor ends the scheduler's page loop after one page
 *     (see `runSourceOnce`), so one poll = one batch = at most `maxBillsPerPoll` bills.
 *     Nothing else stops a cold start from spending the month's budget in one burst.
 *   - **Self-healing.** Fix a bug in the adapter, delete the affected staged rows, and
 *     the next poll re-fetches precisely those bills.
 *
 * ## Query cost
 *
 * One poll spends `2 + min(changed, maxBillsPerPoll)` queries: getSessionList,
 * getMasterListRaw, then one getBill per changed bill. In the steady state "changed"
 * is a handful, so a poll costs ~3 queries against the ~30k/month free tier. A cold
 * start has 12,022 changed bills and drains at `maxBillsPerPoll` per poll.
 *
 * `getBillText` / `getPerson` / `getRollCall` are deliberately never called — see
 * docs/legiscan-il.md. `getBill` already carries the doc links, the sponsor bios and
 * the vote summaries, and the canonical schema has nowhere to put a roll call anyway.
 */

/** LegiScan's own flag for "this session is history". The live session is `prior: 0`. */
function isActive(session: LegiScanSession): boolean {
  return session.prior === 0
}

export interface LegiScanFetcherOptions {
  client: LegiScanApi
  budget: QueryBudget
  knownHashes: KnownHashes
  /**
   * Bills fetched per poll. Bounds a cold start: the 104th GA holds 12,022 bills, and
   * fetching them all in one run would spend 40% of the monthly free tier in a single
   * uninterruptible burst. At the default 500 / 4h cadence a full backfill lands in
   * about four days, and the poll stays interruptible throughout.
   */
  maxBillsPerPoll: number
}

export class LegiScanFetcher implements Fetcher {
  readonly source: Source = 'legiscan_il'
  private readonly client: LegiScanApi
  private readonly budget: QueryBudget
  private readonly knownHashes: KnownHashes
  private readonly maxBillsPerPoll: number

  constructor(opts: LegiScanFetcherOptions) {
    this.client = opts.client
    this.budget = opts.budget
    this.knownHashes = opts.knownHashes
    this.maxBillsPerPoll = opts.maxBillsPerPoll
  }

  async poll(_cursor: string | null): Promise<FetchPage> {
    const sessions = (await this.client.getSessionList()).filter(isActive)
    if (sessions.length === 0) {
      console.warn('[legiscan_il] no active IL session — nothing to poll')
      return { records: [], nextCursor: null }
    }

    const known = await this.knownHashes()
    const changed: MasterListEntry[] = []
    for (const session of sessions) {
      for (const entry of await this.client.getMasterListRaw(session.session_id)) {
        // The hash is the whole test: unchanged hash, unchanged bill, no getBill.
        if (known.get(String(entry.bill_id)) !== entry.change_hash) changed.push(entry)
      }
    }

    if (changed.length === 0) return { records: [], nextCursor: null }

    const batch = await this.bound(changed)
    const records: SourceRecordInput[] = []

    for (const entry of batch) {
      let payload: Record<string, unknown>
      try {
        payload = await this.client.getBill(entry.bill_id)
      } catch (err) {
        // Out of budget: keep what we have. The rest is still "changed" next poll,
        // because nothing was staged for it.
        if (err instanceof BudgetExhaustedError) {
          console.warn(`[legiscan_il] ${err.message} — returning ${records.length} record(s)`)
          break
        }
        throw err
      }
      records.push({
        sourceId: String(entry.bill_id),
        kind: 'bill',
        payload,
        // Staged verbatim: this is what makes the *next* poll's set difference work.
        changeHash: entry.change_hash,
      })
    }

    if (changed.length > records.length) {
      console.log(
        `[legiscan_il] staged ${records.length} of ${changed.length} changed bill(s) — ` +
          `the remainder resumes on the next poll`,
      )
    }

    return { records, nextCursor: null }
  }

  /** Trim the batch to whatever the per-poll cap and the monthly budget both allow. */
  private async bound(changed: MasterListEntry[]): Promise<MasterListEntry[]> {
    const { remaining } = await this.budget.usage()
    const limit = Math.min(this.maxBillsPerPoll, Math.max(0, remaining))
    if (limit < changed.length && limit === remaining) {
      console.warn(
        `[legiscan_il] monthly budget allows only ${remaining} more quer(ies) — ` +
          `capping this poll below the usual ${this.maxBillsPerPoll}`,
      )
    }
    return changed.slice(0, limit)
  }
}

/** Exposed for the fetcher tests. */
export const __testing = { isActive }
