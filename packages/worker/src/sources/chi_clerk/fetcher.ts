import type { Fetcher, FetchPage, Source, SourceRecordInput } from '@interlock/shared'
import type { ListEnvelope, ListKind } from './client'

/** The slice of the eLMS client this fetcher needs (ChiClerkClient satisfies it). */
export interface ChiClerkApi {
  list(kind: ListKind, params: { skip?: number; top?: number; sort?: string }): Promise<ListEnvelope>
  matterDetail(matterId: string): Promise<Record<string, unknown>>
}

/**
 * The Chicago City Clerk eLMS fetcher (ITLK-5).
 *
 * eLMS offers no "changed since X" query — no server-side date filter exists. What
 * it does offer is `lastPublicationDate` on every record (the Clerk added it for
 * exactly this purpose) plus a working descending sort. So a delta poll is a
 * **watermark walk**: page newest-first and stop at the first record we've already
 * seen. Changed records are re-published with a fresh `lastPublicationDate`, so
 * they resurface at the head of the walk — updates to a 2010 ordinance come back
 * around just like a brand-new one.
 *
 * All three eLMS kinds (matter/body/person) share the one `chi_clerk` source, and
 * the seam gives a source exactly one cursor and one advisory lock. So this fetcher
 * drives all three from a single cursor with a `phase` pointer, walking them in
 * turn. Matters carry the legislation; bodies and persons seed the committees and
 * officials that ITLK-7's sponsor matching and ITLK-9's CRM read.
 */

/**
 * Walk order: persons and bodies before matters (ITLK-17). On a cold start the matter
 * phase stages ~every matter across several polls before the next phase runs, so if
 * matters led, sponsor→official matching (ITLK-7) would run before any `official` row
 * existed and leave every sponsorship unlinked — and an unchanged matter is never
 * re-staged to retry (its `lastPublicationDate` short-circuits every later poll), so the
 * gap would persist until each matter re-published. Walking persons then bodies first
 * seeds the officials (and committees) that matters match against, so links land on the
 * first poll. Persons lead bodies so the authoritative official records land first.
 * Steady-state polls are unaffected: persons/bodies are caught up in one tiny list call
 * each, then the walk falls through to matters.
 */
const PHASES = ['person', 'body', 'matter'] as const
type Phase = (typeof PHASES)[number]

/** eLMS sort grammar: ONE space-separated param. `sortDirection` is ignored. */
const SORT_DESC = 'lastPublicationDate desc'
const PAGE_SIZE = 100
/** eLMS rejects skip > 100,000 with a 400. Never walk into it. */
const SKIP_MAX = 100_000

/** Per-kind walk state. `pending` is the new watermark, held until the walk ends. */
interface KindWalk {
  watermark: string | null
  skip: number
  pending: string | null
}

interface ChiClerkCursor {
  phase: Phase
  matter: KindWalk
  body: KindWalk
  person: KindWalk
}

export interface ChiClerkFetcherOptions {
  client: ChiClerkApi
  /**
   * First-poll bound for matters: only ingest what was published in the last N
   * days. Without it a fresh box would walk all ~179k archived matters. Bodies and
   * persons are tiny (139 / 123) and backfill in full.
   */
  backfillDays: number
  /** Injectable clock so the backfill bound is testable. */
  now?: () => Date
}

export class ChiClerkFetcher implements Fetcher {
  readonly source: Source = 'chi_clerk'
  private readonly client: ChiClerkApi
  private readonly backfillDays: number
  private readonly now: () => Date

  constructor(opts: ChiClerkFetcherOptions) {
    this.client = opts.client
    this.backfillDays = opts.backfillDays
    this.now = opts.now ?? ((): Date => new Date())
  }

  async poll(cursor: string | null): Promise<FetchPage> {
    let state = this.parseCursor(cursor)

    // Walk phases until one yields records, or all of them are caught up. An empty
    // page ends the scheduler's poll loop (seam contract), so we must not return
    // one just because *matters* are caught up while bodies still have work.
    for (let guard = 0; guard <= PHASES.length; guard++) {
      const phase = state.phase
      const walk = state[phase]

      const page = await this.client.list(phase, {
        sort: SORT_DESC,
        top: PAGE_SIZE,
        skip: walk.skip,
      })
      const rows = page.data

      // Newest-first, so the head of the first page is the new high-water mark.
      const pending = walk.skip === 0 ? (publishedAt(rows[0]) ?? walk.watermark) : walk.pending

      const fresh = rows.filter((row) => isNewer(publishedAt(row), walk.watermark))
      const nextSkip = walk.skip + rows.length
      // Stop when we reach records we've already seen, run out of pages, or would
      // walk into the server's skip ceiling.
      const caughtUp =
        fresh.length < rows.length || nextSkip >= page.meta.count || nextSkip >= SKIP_MAX
      if (nextSkip >= SKIP_MAX && fresh.length === rows.length) {
        console.warn(
          `[chi_clerk] ${phase} walk hit the skip ceiling (${SKIP_MAX}) with the watermark unreached — truncating this poll`,
        )
      }

      const records = await this.toRecords(phase, fresh)

      if (!caughtUp) {
        // Same phase, next page. The watermark stays put: it only advances once the
        // whole walk lands, so a crash mid-walk re-reads pages instead of skipping them.
        return {
          records,
          nextCursor: serialize({
            ...state,
            [phase]: { watermark: walk.watermark, skip: nextSkip, pending },
          }),
        }
      }

      // Phase complete: commit its watermark and move on.
      const nextIndex = PHASES.indexOf(phase) + 1
      state = {
        ...state,
        [phase]: { watermark: pending ?? walk.watermark, skip: 0, pending: null },
        // Wrapping past the last phase parks the cursor at the start for the next run.
        phase: PHASES[nextIndex] ?? PHASES[0]!,
      }

      if (records.length > 0) return { records, nextCursor: serialize(state) }
      // Nothing new in this phase. If phases remain, keep going inside this poll;
      // otherwise everything is caught up and the empty page ends the loop.
      if (nextIndex >= PHASES.length) return { records: [], nextCursor: serialize(state) }
    }

    /* c8 ignore next 2 -- the loop always returns; this satisfies the type checker. */
    return { records: [], nextCursor: serialize(state) }
  }

  /**
   * Shape fresh rows into staging records. The list view nulls `actions` and
   * `sponsors`, so a matter is re-fetched by id — the detail payload is what gets
   * staged, and it's what the adapter needs. Bodies and persons are complete in
   * the list view already.
   */
  private async toRecords(
    phase: Phase,
    rows: Array<Record<string, unknown>>,
  ): Promise<SourceRecordInput[]> {
    const records: SourceRecordInput[] = []
    for (const row of rows) {
      const id = sourceIdOf(phase, row)
      if (!id) {
        console.warn(`[chi_clerk] skipping a ${phase} row with no id`)
        continue
      }
      const payload = phase === 'matter' ? await this.client.matterDetail(id) : row
      records.push({
        sourceId: id,
        kind: phase,
        payload,
        // eLMS has no change hash; `lastPublicationDate` is its change primitive.
        changeHash: publishedAt(row),
      })
    }
    return records
  }

  private parseCursor(cursor: string | null): ChiClerkCursor {
    if (cursor) {
      try {
        const parsed = JSON.parse(cursor) as Partial<ChiClerkCursor>
        if (parsed && PHASES.includes(parsed.phase as Phase)) {
          return {
            phase: parsed.phase as Phase,
            matter: normalizeWalk(parsed.matter),
            body: normalizeWalk(parsed.body),
            person: normalizeWalk(parsed.person),
          }
        }
      } catch {
        // Fall through to a fresh cursor.
      }
      console.warn('[chi_clerk] unreadable cursor — restarting from the backfill window')
    }
    return {
      phase: PHASES[0],
      matter: { watermark: this.backfillFloor(), skip: 0, pending: null },
      // Tiny collections; take them whole.
      body: { watermark: null, skip: 0, pending: null },
      person: { watermark: null, skip: 0, pending: null },
    }
  }

  /** First-poll floor: ignore anything published longer ago than the backfill window. */
  private backfillFloor(): string {
    const floor = new Date(this.now().getTime() - this.backfillDays * 86_400_000)
    return floor.toISOString()
  }
}

function normalizeWalk(walk: Partial<KindWalk> | undefined): KindWalk {
  return {
    watermark: walk?.watermark ?? null,
    skip: typeof walk?.skip === 'number' && walk.skip >= 0 ? walk.skip : 0,
    pending: walk?.pending ?? null,
  }
}

function serialize(cursor: ChiClerkCursor): string {
  return JSON.stringify(cursor)
}

function publishedAt(row: Record<string, unknown> | undefined): string | null {
  const value = row?.lastPublicationDate
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Strictly newer than the watermark. A row with no `lastPublicationDate` is treated
 * as *not* newer: it can never clear a watermark, so calling it fresh would make the
 * walk re-ingest it on every poll and never terminate.
 */
function isNewer(published: string | null, watermark: string | null): boolean {
  if (published === null) return false
  if (watermark === null) return true
  const a = Date.parse(published)
  const b = Date.parse(watermark)
  if (Number.isNaN(a)) return false
  if (Number.isNaN(b)) return true
  return a > b
}

const ID_FIELD: Record<Phase, string> = {
  matter: 'matterId',
  body: 'bodyId',
  person: 'personId',
}

function sourceIdOf(phase: Phase, row: Record<string, unknown>): string | null {
  const value = row[ID_FIELD[phase]]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Exposed for the fetcher tests. */
export const __testing = { PHASES, SORT_DESC, PAGE_SIZE, SKIP_MAX, isNewer } satisfies Record<
  string,
  unknown
>

export type { ListKind }
