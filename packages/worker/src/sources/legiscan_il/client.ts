import { BudgetExhaustedError, type QueryBudget } from './budget'

/**
 * HTTP client for the LegiScan API (api.legiscan.com — free tier, key required).
 *
 * The grammar is one endpoint and a verb: `/?key=…&op=…&id=…`. Everything below was
 * pinned against the live API for Illinois (ITLK-6 recon, 2026-07-13):
 *
 *   - `getSessionList&state=IL` → every IL session ever. `prior: 0` marks the live
 *     one. **`sine_die` does not** — the 104th GA is flagged `sine_die: 1` while it
 *     is still the current session, so filtering on it ingests nothing at all.
 *   - `getMasterListRaw&id={session_id}` → the whole session as `{bill_id, number,
 *     change_hash}`, no paging: 12,022 bills for the 104th GA in ONE query. This is
 *     the change primitive the whole fetcher is built on.
 *   - `getBill&id={bill_id}` → the full record. It already contains sponsors (with
 *     `people_id`, party, district and a bio block), history, progress, texts and
 *     vote summaries, so the follow-up ops the brief anticipated — `getBillText`,
 *     `getPerson`, `getRollCall` — would re-fetch data we are already holding.
 *
 * Errors do NOT come back as HTTP status codes: a failure is an HTTP 200 carrying
 * `{"status":"ERROR","alert":{"message":…}}`, which includes the "subscription
 * exhausted" response. Treating a 200 as success is therefore a real bug, and
 * `request()` below checks the envelope, not the status line.
 */

/** Just the call shape we use — global `fetch` satisfies it, and so does a test stub. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface LegiScanSession {
  session_id: number
  session_name: string
  session_title: string
  year_start: number
  year_end: number
  /** 1 = archived/historical. The live session is the one with `prior: 0`. */
  prior: number
  sine_die: number
  special: number
}

/** One master-list entry: LegiScan's whole change-detection surface. */
export interface MasterListEntry {
  bill_id: number
  number: string
  change_hash: string
}

export interface LegiScanClientOptions {
  apiKey: string
  baseUrl?: string
  /** ISO state code; IL for this project. */
  state?: string
  /** Self-imposed request cap — LegiScan publishes no rate limit, only a monthly cap. */
  maxRps?: number
  /** Retries on 429/5xx before giving up. */
  maxRetries?: number
  /** Durable query accounting. Every request spends exactly one query. */
  budget: QueryBudget
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** LegiScan's "you are out of queries" alert, which arrives as a 200. */
function isQuotaAlert(message: string): boolean {
  return /subscription|exhaust|limit|quota|exceed/i.test(message)
}

export class LegiScanClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly state: string
  private readonly minIntervalMs: number
  private readonly maxRetries: number
  private readonly budget: QueryBudget
  private readonly fetchImpl: FetchLike
  private readonly sleep: (ms: number) => Promise<void>
  private nextAllowedAt = 0

  constructor(opts: LegiScanClientOptions) {
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? 'https://api.legiscan.com').replace(/\/+$/, '')
    this.state = opts.state ?? 'IL'
    this.minIntervalMs = 1000 / (opts.maxRps ?? 2)
    this.maxRetries = opts.maxRetries ?? 4
    this.budget = opts.budget
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.sleep = opts.sleep ?? defaultSleep
  }

  /** Every session LegiScan holds for the state, newest first. */
  async getSessionList(): Promise<LegiScanSession[]> {
    const body = await this.request({ op: 'getSessionList', state: this.state })
    const sessions = (body as { sessions?: unknown }).sessions
    if (!Array.isArray(sessions)) throw new Error('[legiscan_il] getSessionList returned no sessions')
    return sessions as LegiScanSession[]
  }

  /**
   * The whole session as bill_id + change_hash. One query, no paging.
   *
   * The response is an object keyed by array *index* — `{session: {...}, "0": {...},
   * "1": {...}}` — not a JSON array, so the session key has to be dropped by name
   * rather than by position.
   */
  async getMasterListRaw(sessionId: number): Promise<MasterListEntry[]> {
    const body = await this.request({ op: 'getMasterListRaw', id: String(sessionId) })
    const masterlist = (body as { masterlist?: Record<string, unknown> }).masterlist
    if (!masterlist || typeof masterlist !== 'object') {
      throw new Error(`[legiscan_il] getMasterListRaw ${sessionId} returned no masterlist`)
    }
    const entries: MasterListEntry[] = []
    for (const [key, value] of Object.entries(masterlist)) {
      if (key === 'session' || !value || typeof value !== 'object') continue
      const entry = value as Partial<MasterListEntry>
      if (typeof entry.bill_id === 'number' && typeof entry.change_hash === 'string') {
        entries.push(entry as MasterListEntry)
      }
    }
    return entries
  }

  /** The full bill record — sponsors, history, progress, texts, vote summaries. */
  async getBill(billId: number): Promise<Record<string, unknown>> {
    const body = await this.request({ op: 'getBill', id: String(billId) })
    const bill = (body as { bill?: Record<string, unknown> }).bill
    if (!bill || typeof bill !== 'object' || bill.bill_id == null) {
      throw new Error(`[legiscan_il] getBill ${billId} returned an unexpected payload`)
    }
    return bill
  }

  /**
   * Throttled GET: spend a query, check the envelope, retry 429/5xx.
   *
   * The budget is spent *before* the request, not after: a query LegiScan served but
   * whose response we dropped on the floor still came out of the monthly cap, and
   * under-counting is the failure mode that silently overruns the free tier.
   */
  private async request(params: Record<string, string>): Promise<unknown> {
    const usage = await this.budget.spend(1)
    if (usage.used > usage.limit) throw new BudgetExhaustedError(usage)

    const qs = new URLSearchParams({ key: this.apiKey, ...params })
    const url = `${this.baseUrl}/?${qs.toString()}`
    const label = params.op ?? 'request'

    for (let attempt = 0; ; attempt++) {
      await this.throttle()

      let res: Response
      try {
        res = await this.fetchImpl(url, { headers: { accept: 'application/json' } })
      } catch (err) {
        if (attempt >= this.maxRetries) throw err
        await this.sleep(this.backoffMs(attempt))
        continue
      }

      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500
        if (!retryable || attempt >= this.maxRetries) {
          throw new Error(`[legiscan_il] ${label} failed: ${res.status} ${res.statusText}`)
        }
        const retryAfter = Number(res.headers.get('retry-after'))
        await this.sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : this.backoffMs(attempt),
        )
        continue
      }

      const body: unknown = await res.json()
      const envelope = body as { status?: string; alert?: { message?: string } }
      if (envelope.status === 'OK') return body

      // A 200 that isn't OK. Quota alerts are terminal — retrying one just burns
      // the queries we have left proving the point.
      const message = envelope.alert?.message ?? 'unknown error'
      if (isQuotaAlert(message)) {
        throw new BudgetExhaustedError({ used: usage.limit, limit: usage.limit, remaining: 0 })
      }
      throw new Error(`[legiscan_il] ${label} returned status ${envelope.status}: ${message}`)
    }
  }

  /** Space requests at least `minIntervalMs` apart. */
  private async throttle(): Promise<void> {
    const now = Date.now()
    const wait = this.nextAllowedAt - now
    if (wait > 0) await this.sleep(wait)
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.minIntervalMs
  }

  private backoffMs(attempt: number): number {
    return Math.min(500 * 2 ** attempt, 30_000)
  }
}
