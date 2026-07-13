import { describe, expect, test } from 'bun:test'
import type { ListEnvelope, ListKind } from './client'
import { ChiClerkFetcher, type ChiClerkApi } from './fetcher'

/**
 * ITLK-5 fetcher unit tests. No database and no network: a fake eLMS stands in for
 * the API so the delta walk itself is what's under test — that it stops at the
 * watermark, pages by skip, bounds the first poll, and covers all three kinds.
 */

/** A fake eLMS holding rows per kind, newest-first (as `sort=... desc` returns them). */
class FakeELMS implements ChiClerkApi {
  readonly calls: Array<{ kind: ListKind; skip: number; top: number; sort?: string }> = []
  readonly detailCalls: string[] = []

  constructor(
    private readonly rows: Record<ListKind, Array<Record<string, unknown>>>,
    private readonly pageSize = 100,
  ) {}

  list(
    kind: ListKind,
    params: { skip?: number; top?: number; sort?: string },
  ): Promise<ListEnvelope> {
    const skip = params.skip ?? 0
    const top = Math.min(params.top ?? this.pageSize, this.pageSize)
    this.calls.push({ kind, skip, top, sort: params.sort })
    const all = this.rows[kind]
    const sorted = [...all].sort(
      (a, b) => Date.parse(String(b.lastPublicationDate)) - Date.parse(String(a.lastPublicationDate)),
    )
    return Promise.resolve({
      data: sorted.slice(skip, skip + top),
      meta: { skip, top, count: all.length, pages: Math.ceil(all.length / top) },
    })
  }

  matterDetail(matterId: string): Promise<Record<string, unknown>> {
    this.detailCalls.push(matterId)
    const row = this.rows.matter.find((m) => m.matterId === matterId)
    // The real detail view populates actions/sponsors, which the list view nulls.
    return Promise.resolve({ ...row, actions: [{ historyId: `h-${matterId}` }], detail: true })
  }
}

function matter(n: number, published: string): Record<string, unknown> {
  return { matterId: `m${n}`, recordNumber: `O2026-${n}`, lastPublicationDate: published }
}
function person(n: number, published: string): Record<string, unknown> {
  return { personId: `p${n}`, displayName: `Alder ${n}`, lastPublicationDate: published }
}
function body(n: number, published: string): Record<string, unknown> {
  return { bodyId: `b${n}`, body: `Committee ${n}`, lastPublicationDate: published }
}

const NOW = new Date('2026-07-12T00:00:00Z')

function fetcherFor(elms: ChiClerkApi, backfillDays = 30): ChiClerkFetcher {
  return new ChiClerkFetcher({ client: elms, backfillDays, now: () => NOW })
}

/** Drive poll() the way the seam scheduler does, to exhaustion. */
async function drain(
  fetcher: ChiClerkFetcher,
  start: string | null = null,
): Promise<{ records: Array<{ sourceId: string; kind: string }>; cursor: string | null }> {
  let cursor = start
  const records: Array<{ sourceId: string; kind: string }> = []
  for (let i = 0; i < 50; i++) {
    const page = await fetcher.poll(cursor)
    records.push(...page.records.map((r) => ({ sourceId: r.sourceId, kind: r.kind })))
    if (page.records.length === 0 || page.nextCursor === null || page.nextCursor === cursor) {
      return { records, cursor: page.nextCursor ?? cursor }
    }
    cursor = page.nextCursor
  }
  throw new Error('poll loop did not terminate')
}

describe('ChiClerkFetcher', () => {
  test('first poll ingests all three kinds and bounds matters by the backfill window', async () => {
    const elms = new FakeELMS({
      // Two recent matters, one published long before the 30-day window.
      matter: [
        matter(1, '2026-07-10T00:00:00Z'),
        matter(2, '2026-07-01T00:00:00Z'),
        matter(3, '2024-06-06T00:00:00Z'), // outside the backfill window
      ],
      person: [person(1, '2023-06-16T00:00:00Z')], // persons backfill in full
      body: [body(1, '2024-01-04T00:00:00Z')],
    })
    const { records, cursor } = await drain(fetcherFor(elms))

    expect(records.filter((r) => r.kind === 'matter').map((r) => r.sourceId)).toEqual(['m1', 'm2'])
    // Bodies and persons are tiny, so they are taken whole regardless of age.
    expect(records.filter((r) => r.kind === 'person').map((r) => r.sourceId)).toEqual(['p1'])
    expect(records.filter((r) => r.kind === 'body').map((r) => r.sourceId)).toEqual(['b1'])

    // Matters are staged as DETAIL payloads — the list view nulls actions/sponsors.
    expect(elms.detailCalls).toEqual(['m1', 'm2'])

    // Every list call used the one-param descending sort grammar.
    expect(elms.calls.every((c) => c.sort === 'lastPublicationDate desc')).toBe(true)

    const state = JSON.parse(cursor!)
    expect(state.matter.watermark).toBe('2026-07-10T00:00:00Z') // the newest seen
    expect(state.matter.skip).toBe(0)
    expect(state.phase).toBe('matter') // parked for the next run
  })

  test('re-poll with no upstream change fetches nothing new', async () => {
    const elms = new FakeELMS({
      matter: [matter(1, '2026-07-10T00:00:00Z')],
      person: [person(1, '2026-07-01T00:00:00Z')],
      body: [body(1, '2026-07-01T00:00:00Z')],
    })
    const fetcher = fetcherFor(elms)
    const first = await drain(fetcher)
    expect(first.records).toHaveLength(3)

    const second = await drain(fetcher, first.cursor)
    expect(second.records).toEqual([]) // watermark held — this is the zero-write proof
    expect(elms.detailCalls).toEqual(['m1']) // no redundant detail fetches
  })

  test('a changed record resurfaces at the head of the walk', async () => {
    const elms = new FakeELMS({
      matter: [matter(1, '2026-07-10T00:00:00Z'), matter(2, '2026-07-09T00:00:00Z')],
      person: [],
      body: [],
    })
    const fetcher = fetcherFor(elms)
    const first = await drain(fetcher)
    expect(first.records.map((r) => r.sourceId)).toEqual(['m1', 'm2'])

    // eLMS republishes m2 with a fresh lastPublicationDate — that's its change signal.
    elms['rows'].matter[1]!.lastPublicationDate = '2026-07-11T00:00:00Z'

    const second = await drain(fetcher, first.cursor)
    expect(second.records.map((r) => r.sourceId)).toEqual(['m2'])
    expect(JSON.parse(second.cursor!).matter.watermark).toBe('2026-07-11T00:00:00Z')
  })

  test('walks past the first page: skip paging, watermark held until the walk ends', async () => {
    // 5 matters, page size 2 → three pages, all newer than the watermark.
    const rows = [
      matter(1, '2026-07-10T00:00:00Z'),
      matter(2, '2026-07-09T00:00:00Z'),
      matter(3, '2026-07-08T00:00:00Z'),
      matter(4, '2026-07-07T00:00:00Z'),
      matter(5, '2026-07-06T00:00:00Z'),
    ]
    const elms = new FakeELMS({ matter: rows, person: [], body: [] }, 2)
    const fetcher = fetcherFor(elms)

    // Mid-walk the cursor must still carry the OLD watermark, so a crash re-reads
    // pages rather than skipping them.
    const page1 = await fetcher.poll(null)
    const mid = JSON.parse(page1.nextCursor!)
    expect(mid.matter.skip).toBe(2)
    expect(mid.matter.pending).toBe('2026-07-10T00:00:00Z') // new mark, not yet committed
    expect(mid.matter.watermark).not.toBe('2026-07-10T00:00:00Z')

    // Resume from mid-walk, the way the scheduler would.
    const rest = await drain(fetcher, page1.nextCursor)
    const seen = [...page1.records, ...rest.records].map((r) => r.sourceId)
    expect(seen).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    // Only once the walk finishes does the watermark advance.
    expect(JSON.parse(rest.cursor!).matter.watermark).toBe('2026-07-10T00:00:00Z')
    expect(elms.calls.filter((c) => c.kind === 'matter').map((c) => c.skip)).toEqual([0, 2, 4])
  })

  test('a caught-up matter phase still lets bodies and persons through', async () => {
    // The regression this guards: an empty page ends the scheduler's poll loop, so a
    // caught-up first phase must not strand the phases behind it.
    const elms = new FakeELMS({
      matter: [matter(1, '2026-07-10T00:00:00Z')],
      person: [person(1, '2026-07-01T00:00:00Z')],
      body: [body(1, '2026-07-01T00:00:00Z')],
    })
    const fetcher = fetcherFor(elms)
    const first = await drain(fetcher)
    expect(first.records).toHaveLength(3)

    // Matters unchanged; a new committee appears.
    elms['rows'].body.push(body(2, '2026-07-11T00:00:00Z'))
    const second = await drain(fetcher, first.cursor)
    expect(second.records).toEqual([{ sourceId: 'b2', kind: 'body' }])
  })

  test('an unreadable cursor restarts from the backfill window instead of throwing', async () => {
    const elms = new FakeELMS({
      matter: [matter(1, '2026-07-10T00:00:00Z'), matter(2, '2020-01-01T00:00:00Z')],
      person: [],
      body: [],
    })
    const { records } = await drain(fetcherFor(elms), 'not json')
    expect(records.map((r) => r.sourceId)).toEqual(['m1'])
  })

  test('records carry lastPublicationDate as the change hash', async () => {
    const elms = new FakeELMS({ matter: [matter(1, '2026-07-10T00:00:00Z')], person: [], body: [] })
    const page = await fetcherFor(elms).poll(null)
    expect(page.records[0]!.changeHash).toBe('2026-07-10T00:00:00Z')
    expect(page.records[0]!.payload.detail).toBe(true)
  })
})
