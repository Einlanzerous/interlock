/**
 * HTTP client for the Chicago City Clerk eLMS API
 * (api.chicityclerkelms.chicago.gov — public, no key).
 *
 * The eLMS query grammar was pinned against the live API (ITLK-5 recon):
 *   - list endpoints return `{ data: [...], meta: { skip, top, count, pages } }`
 *   - pagination is bare `skip` + `top` (default top=100); `skip` is capped at
 *     100,000 server-side (HTTP 400 beyond)
 *   - sort is ONE space-separated param: `sort=lastPublicationDate desc`. The
 *     separate `sortDirection` param is ignored, and a bare `sort=field` sorts
 *     ascending. There is no server-side date filter.
 *   - `/matter/{id}` detail returns the object directly (no envelope) and, unlike
 *     the list view, populates `actions`/`sponsors`/`attachments`.
 *
 * eLMS publishes no rate limit or SLA, so we self-cap at `maxRps` and retry
 * 429/5xx with exponential backoff. The seam already guarantees single-flight
 * per source, so a plain min-interval throttle is enough here.
 */

/** A `{ data, meta }` list envelope. */
export interface EnvelopeMeta {
  skip: number
  top: number
  count: number
  pages: number
}
export interface ListEnvelope {
  data: Array<Record<string, unknown>>
  meta: EnvelopeMeta
}

/** Kinds with a list endpoint; each carries `lastPublicationDate` for deltas. */
export type ListKind = 'matter' | 'body' | 'person'

/**
 * Just the call shape we use — global `fetch` satisfies it, and so does a test stub
 * (which `typeof fetch` would reject over incidentals like `fetch.preconnect`).
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface ChiClerkClientOptions {
  baseUrl: string
  /** Max requests per second (self-imposed; eLMS has no published limit). */
  maxRps?: number
  /** Retries on 429/5xx before giving up. */
  maxRetries?: number
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike
  /** Injectable sleep (tests skip real backoff waits). */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Parse an eLMS body, unwrapping the double-encoding quirk.
 *
 * `/matter/{id}` answers an `Accept: application/json` request with a JSON *string*
 * whose contents are the JSON object — `"{\"matterId\":...}"` — so a plain
 * `res.json()` hands back a string and every field reads as undefined. (Drop the
 * Accept header and the same endpoint returns a normal object; the list endpoints
 * are unaffected either way.) Decoding twice when the first parse yields a string
 * handles both shapes, so this keeps working if the Clerk ever fixes it.
 */
function parseBody(text: string): unknown {
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === 'string' ? JSON.parse(parsed) : parsed
}

export class ChiClerkClient {
  private readonly baseUrl: string
  private readonly minIntervalMs: number
  private readonly maxRetries: number
  private readonly fetchImpl: FetchLike
  private readonly sleep: (ms: number) => Promise<void>
  private nextAllowedAt = 0

  constructor(opts: ChiClerkClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.minIntervalMs = 1000 / (opts.maxRps ?? 2)
    this.maxRetries = opts.maxRetries ?? 4
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.sleep = opts.sleep ?? defaultSleep
  }

  /** One list page. `sort` is passed verbatim (e.g. `lastPublicationDate desc`). */
  async list(
    kind: ListKind,
    params: { skip?: number; top?: number; sort?: string },
  ): Promise<ListEnvelope> {
    const qs = new URLSearchParams()
    if (params.sort) qs.set('sort', params.sort)
    if (params.top != null) qs.set('top', String(params.top))
    if (params.skip != null) qs.set('skip', String(params.skip))
    const body = (await this.request(`/${kind}?${qs.toString()}`)) as ListEnvelope
    if (!body || !Array.isArray(body.data) || !body.meta) {
      throw new Error(`eLMS /${kind} returned an unexpected envelope`)
    }
    return body
  }

  /** Full matter detail — the payload with actions/sponsors/attachments. */
  async matterDetail(matterId: string): Promise<Record<string, unknown>> {
    const body = (await this.request(`/matter/${encodeURIComponent(matterId)}`)) as Record<
      string,
      unknown
    >
    if (!body || typeof body !== 'object' || !body.matterId) {
      throw new Error(`eLMS /matter/${matterId} returned an unexpected payload`)
    }
    return body
  }

  /** Throttled GET with JSON parse and 429/5xx retry. */
  private async request(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`
    for (let attempt = 0; ; attempt++) {
      await this.throttle()
      let res: Response
      try {
        res = await this.fetchImpl(url, { headers: { accept: 'application/json' } })
      } catch (err) {
        // Network error — retry like a 5xx.
        if (attempt >= this.maxRetries) throw err
        await this.sleep(this.backoffMs(attempt))
        continue
      }
      if (res.ok) return parseBody(await res.text())
      const retryable = res.status === 429 || res.status >= 500
      if (!retryable || attempt >= this.maxRetries) {
        throw new Error(`eLMS GET ${path} failed: ${res.status} ${res.statusText}`)
      }
      const retryAfter = Number(res.headers.get('retry-after'))
      await this.sleep(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoffMs(attempt),
      )
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
