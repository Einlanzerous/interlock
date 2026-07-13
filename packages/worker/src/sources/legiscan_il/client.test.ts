import { describe, expect, test } from 'bun:test'
import { LegiScanClient, type FetchLike } from './client'
import { BudgetExhaustedError, MemoryQueryBudget } from './budget'

/**
 * ITLK-6 client unit tests — no network; `fetchImpl` is injected.
 *
 * The case that matters most is the error envelope: LegiScan reports failure as an
 * HTTP **200** carrying `{"status":"ERROR"}`, so a client that trusts the status line
 * treats "you are out of queries" as a successful response and parses garbage.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function clientWith(
  fetchImpl: FetchLike,
  opts: { maxRetries?: number; limit?: number } = {},
): { client: LegiScanClient; budget: MemoryQueryBudget } {
  const budget = new MemoryQueryBudget(opts.limit ?? 1000)
  const client = new LegiScanClient({
    apiKey: 'test-key',
    baseUrl: 'https://legiscan.test',
    maxRps: 1000, // don't actually throttle the tests
    maxRetries: opts.maxRetries ?? 4,
    budget,
    fetchImpl,
    sleep: () => Promise.resolve(),
  })
  return { client, budget }
}

describe('LegiScanClient', () => {
  test('an HTTP 200 carrying status ERROR is a failure, not a payload', async () => {
    const { client } = clientWith(() =>
      Promise.resolve(jsonResponse({ status: 'ERROR', alert: { message: 'Unknown bill id' } })),
    )
    await expect(client.getBill(1)).rejects.toThrow(/Unknown bill id/)
  })

  test('the quota alert is terminal — retrying it would burn the queries left proving the point', async () => {
    let calls = 0
    const { client } = clientWith(() => {
      calls++
      return Promise.resolve(
        jsonResponse({ status: 'ERROR', alert: { message: 'Subscription query limit exceeded' } }),
      )
    })

    await expect(client.getBill(1)).rejects.toBeInstanceOf(BudgetExhaustedError)
    expect(calls).toBe(1)
  })

  test('every request spends exactly one query, before it is sent', async () => {
    const { client, budget } = clientWith(() =>
      Promise.resolve(jsonResponse({ status: 'OK', bill: { bill_id: 1 } })),
    )

    await client.getBill(1)
    await client.getBill(2)

    // Spent up-front: a query LegiScan served but whose response we dropped still
    // came out of the monthly cap, and under-counting is what overruns the free tier.
    expect((await budget.usage()).used).toBe(2)
  })

  test('a retried 5xx spends one query, not one per attempt', async () => {
    let calls = 0
    const { client, budget } = clientWith(() => {
      calls++
      return Promise.resolve(
        calls < 3
          ? jsonResponse({ status: 'ERROR' }, 503)
          : jsonResponse({ status: 'OK', bill: { bill_id: 7 } }),
      )
    })

    const bill = await client.getBill(7)

    expect(bill.bill_id).toBe(7)
    expect(calls).toBe(3)
    expect((await budget.usage()).used).toBe(1)
  })

  test('refuses to send once the budget is spent', async () => {
    let calls = 0
    const { client } = clientWith(
      () => {
        calls++
        return Promise.resolve(jsonResponse({ status: 'OK', bill: { bill_id: 1 } }))
      },
      { limit: 1 },
    )

    await client.getBill(1)
    await expect(client.getBill(2)).rejects.toBeInstanceOf(BudgetExhaustedError)
    expect(calls).toBe(1) // the second request never left the process
  })

  test('getMasterListRaw drops the `session` key rather than the first entry', async () => {
    // The response is an object keyed by array index with `session` mixed in, not an
    // array — dropping by position would silently lose bill 0 and keep the session.
    const { client } = clientWith(() =>
      Promise.resolve(
        jsonResponse({
          status: 'OK',
          masterlist: {
            session: { session_id: 2176 },
            '0': { bill_id: 1906128, number: 'HB0001', change_hash: 'aaa' },
            '1': { bill_id: 1906465, number: 'HB0006', change_hash: 'bbb' },
          },
        }),
      ),
    )

    const entries = await client.getMasterListRaw(2176)

    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.bill_id)).toEqual([1906128, 1906465])
  })

  test('sends the key and the op, and asks for the configured state', async () => {
    const urls: string[] = []
    const { client } = clientWith((url) => {
      urls.push(url)
      return Promise.resolve(jsonResponse({ status: 'OK', sessions: [] }))
    })

    await client.getSessionList()

    const url = new URL(urls[0]!)
    expect(url.searchParams.get('key')).toBe('test-key')
    expect(url.searchParams.get('op')).toBe('getSessionList')
    expect(url.searchParams.get('state')).toBe('IL')
  })
})
