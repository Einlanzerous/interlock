import { describe, expect, test } from 'bun:test'
import { ChiClerkClient, type FetchLike } from './client'

/**
 * ITLK-5 client unit tests — no network; `fetchImpl` is injected.
 *
 * The double-encoding case is the one that matters most: it's a real eLMS quirk that
 * only surfaced against live traffic, and it fails silently (every field reads as
 * undefined) rather than loudly.
 */

const MATTER = { matterId: 'M-1', title: 'A matter', lastPublicationDate: '2026-07-10T00:00:00Z' }

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}

function clientWith(fetchImpl: FetchLike, maxRetries = 4): ChiClerkClient {
  return new ChiClerkClient({
    baseUrl: 'https://elms.test',
    maxRps: 1000, // don't actually throttle the tests
    maxRetries,
    fetchImpl,
    sleep: () => Promise.resolve(),
  })
}

describe('ChiClerkClient', () => {
  test('unwraps the double-encoded detail payload eLMS returns', async () => {
    // What the live API actually sends for /matter/{id}: a JSON *string* of JSON.
    const doubleEncoded = JSON.stringify(JSON.stringify(MATTER))
    const client = clientWith(() => Promise.resolve(jsonResponse(doubleEncoded)))

    const detail = await client.matterDetail('M-1')
    expect(detail.matterId).toBe('M-1')
    expect(detail.title).toBe('A matter')
  })

  test('still accepts a plain object payload (if the Clerk ever fixes it)', async () => {
    const client = clientWith(() => Promise.resolve(jsonResponse(JSON.stringify(MATTER))))
    const detail = await client.matterDetail('M-1')
    expect(detail.matterId).toBe('M-1')
  })

  test('sends the one-param sort grammar and bare skip/top', async () => {
    let seen = ''
    const client = clientWith((url) => {
      seen = String(url)
      return Promise.resolve(jsonResponse(JSON.stringify({ data: [], meta: { skip: 0, top: 100, count: 0, pages: 0 } })))
    })
    await client.list('matter', { sort: 'lastPublicationDate desc', top: 100, skip: 200 })

    const params = new URL(seen).searchParams
    // `sortDirection` is ignored by eLMS; direction rides along inside `sort`.
    expect(params.get('sort')).toBe('lastPublicationDate desc')
    expect(params.get('top')).toBe('100')
    expect(params.get('skip')).toBe('200')
  })

  test('retries 429 and 5xx, then succeeds', async () => {
    let calls = 0
    const client = clientWith(() => {
      calls++
      if (calls === 1) return Promise.resolve(new Response('slow down', { status: 429 }))
      if (calls === 2) return Promise.resolve(new Response('boom', { status: 503 }))
      return Promise.resolve(jsonResponse(JSON.stringify(MATTER)))
    })

    const detail = await client.matterDetail('M-1')
    expect(detail.matterId).toBe('M-1')
    expect(calls).toBe(3)
  })

  test('gives up after maxRetries and surfaces the status', async () => {
    let calls = 0
    const client = clientWith(() => {
      calls++
      return Promise.resolve(new Response('nope', { status: 500 }))
    }, 2)

    await expect(client.matterDetail('M-1')).rejects.toThrow(/500/)
    expect(calls).toBe(3) // the first try plus two retries
  })

  test('does not retry a 4xx that will never succeed', async () => {
    let calls = 0
    const client = clientWith(() => {
      calls++
      // What eLMS returns past skip=100,000.
      return Promise.resolve(new Response('skip too large', { status: 400 }))
    })

    await expect(client.list('matter', { skip: 200_000 })).rejects.toThrow(/400/)
    expect(calls).toBe(1)
  })

  test('rejects a list response that is not a { data, meta } envelope', async () => {
    const client = clientWith(() => Promise.resolve(jsonResponse(JSON.stringify({ nope: true }))))
    await expect(client.list('matter', {})).rejects.toThrow(/envelope/)
  })
})
