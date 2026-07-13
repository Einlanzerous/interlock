import { describe, expect, test } from 'bun:test'
import { LegiScanFetcher, type LegiScanApi } from './fetcher'
import { BudgetExhaustedError, MemoryQueryBudget } from './budget'
import type { LegiScanSession, MasterListEntry } from './client'

/**
 * ITLK-6 fetcher unit tests — no network, no DB. The client and the change-hash port
 * are both injected, so these assert the ticket's headline criteria directly:
 *
 *   - only changed/new bills trigger getBill (query count ≈ 1 + changed-bill count)
 *   - an unchanged change_hash fires no getBill and stages nothing
 */

const SESSIONS: LegiScanSession[] = [
  // The live one. Note sine_die: 1 — the 104th GA really is flagged adjourned while
  // still current, so a fetcher that filters on sine_die ingests nothing at all.
  {
    session_id: 2176,
    session_name: '104th General Assembly',
    session_title: '2025-2026 Regular Session',
    year_start: 2025,
    year_end: 2026,
    prior: 0,
    sine_die: 1,
    special: 0,
  },
  {
    session_id: 2020,
    session_name: '103rd General Assembly',
    session_title: '2023-2024 Regular Session',
    year_start: 2023,
    year_end: 2024,
    prior: 1,
    sine_die: 1,
    special: 0,
  },
]

interface Calls {
  sessionList: number
  masterList: number[]
  bills: number[]
}

/**
 * A stand-in for LegiScanClient. It spends from the budget on every op, exactly as the
 * real client does — otherwise the budget tests below would be asserting against a
 * fake that cannot run out of money, which is the only interesting thing about it.
 */
function fakeApi(
  entries: MasterListEntry[],
  budget: MemoryQueryBudget,
): { api: LegiScanApi; calls: Calls } {
  const calls: Calls = { sessionList: 0, masterList: [], bills: [] }
  const spend = async (): Promise<void> => {
    const usage = await budget.spend(1)
    if (usage.used > usage.limit) throw new BudgetExhaustedError(usage)
  }
  const api: LegiScanApi = {
    getSessionList: async () => {
      await spend()
      calls.sessionList++
      return SESSIONS
    },
    getMasterListRaw: async (sessionId) => {
      await spend()
      calls.masterList.push(sessionId)
      return entries
    },
    getBill: async (billId) => {
      await spend()
      calls.bills.push(billId)
      return { bill_id: billId, bill_number: `HB${billId}` }
    },
  }
  return { api, calls }
}

const entry = (id: number, hash: string): MasterListEntry => ({
  bill_id: id,
  number: `HB${id}`,
  change_hash: hash,
})

/** Wire a fetcher and its fake client onto one shared budget. */
function harness(
  entries: MasterListEntry[],
  known: Map<string, string> = new Map(),
  opts: { maxBillsPerPoll?: number; limit?: number } = {},
): { fetcher: LegiScanFetcher; calls: Calls } {
  const budget = new MemoryQueryBudget(opts.limit ?? 30_000)
  const { api, calls } = fakeApi(entries, budget)
  const fetcher = new LegiScanFetcher({
    client: api,
    budget,
    knownHashes: async () => known,
    maxBillsPerPoll: opts.maxBillsPerPoll ?? 500,
  })
  return { fetcher, calls }
}

describe('LegiScanFetcher', () => {
  test('polls only the active session — `prior: 0`, not `sine_die`', async () => {
    const { fetcher, calls } = harness([entry(1, 'a')])
    await fetcher.poll(null)

    expect(calls.masterList).toEqual([2176]) // never 2020
  })

  test('a cold start fetches every bill and stages it with its change_hash', async () => {
    const { fetcher, calls } = harness([entry(1, 'a'), entry(2, 'b')])

    const page = await fetcher.poll(null)

    expect(calls.bills).toEqual([1, 2])
    expect(page.records).toHaveLength(2)
    expect(page.records[0]).toMatchObject({ sourceId: '1', kind: 'bill', changeHash: 'a' })
  })

  test('an unchanged change_hash fires no getBill and stages nothing', async () => {
    const known = new Map([
      ['1', 'a'],
      ['2', 'b'],
    ])
    const { fetcher, calls } = harness([entry(1, 'a'), entry(2, 'b')], known)

    const page = await fetcher.poll(null)

    expect(calls.bills).toEqual([])
    expect(page.records).toEqual([])
    // 2 queries for the whole poll: getSessionList + getMasterListRaw.
    expect(calls.sessionList + calls.masterList.length).toBe(2)
  })

  test('only the changed and the new bill cost a getBill', async () => {
    const known = new Map([
      ['1', 'a'],
      ['2', 'b'],
    ])
    const { fetcher, calls } = harness(
      [
        entry(1, 'a'), // unchanged
        entry(2, 'CHANGED'), // hash moved
        entry(3, 'c'), // never seen
      ],
      known,
    )

    const page = await fetcher.poll(null)

    // The acceptance criterion, literally: 1 master-list query + one getBill per
    // changed bill (plus the session lookup).
    expect(calls.bills).toEqual([2, 3])
    expect(page.records.map((r) => r.sourceId)).toEqual(['2', '3'])
  })

  test('a cursor is never minted — the staged change_hashes are the resume state', async () => {
    const { fetcher } = harness([entry(1, 'a')])

    const page = await fetcher.poll('anything at all')

    // nextCursor: null also ends the scheduler's page loop after one page, which is
    // what bounds a cold start to maxBillsPerPoll.
    expect(page.nextCursor).toBeNull()
  })

  test('a cold start is capped per poll, and the remainder resumes on the next one', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(i + 1, `h${i + 1}`))

    const first = harness(entries, new Map(), { maxBillsPerPoll: 4 })
    const page = await first.fetcher.poll(null)
    expect(first.calls.bills).toEqual([1, 2, 3, 4])
    expect(page.records).toHaveLength(4)

    // Next poll: the four that landed are now known, so it picks up where it left off.
    const known = new Map(page.records.map((r) => [r.sourceId, r.changeHash!]))
    const second = harness(entries, known, { maxBillsPerPoll: 4 })
    await second.fetcher.poll(null)

    expect(second.calls.bills).toEqual([5, 6, 7, 8])
  })

  test('the monthly budget caps the batch below the per-poll limit when it is nearly spent', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(i + 1, `h${i + 1}`))
    // 5 queries left in the month. getSessionList and getMasterListRaw take two of
    // them, so only three bills are reachable.
    const { fetcher, calls } = harness(entries, new Map(), { maxBillsPerPoll: 500, limit: 5 })

    const page = await fetcher.poll(null)

    expect(calls.bills).toEqual([1, 2, 3])
    // Whatever it could not reach is simply still "changed" next poll — nothing was
    // staged for it, so nothing is lost.
    expect(page.records).toHaveLength(3)
  })

  test('running out of budget mid-batch keeps the records already fetched', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(i + 1, `h${i + 1}`))
    // The fetcher will size its batch from `remaining`, so force the exhaustion to bite
    // inside the loop by letting it plan for more than it can spend.
    const budget = new MemoryQueryBudget(4)
    const { api, calls } = fakeApi(entries, budget)
    const fetcher = new LegiScanFetcher({
      client: api,
      budget: { spend: (n) => budget.spend(n), usage: async () => ({ used: 0, limit: 10, remaining: 10 }) },
      knownHashes: async () => new Map(),
      maxBillsPerPoll: 10,
    })

    const page = await fetcher.poll(null)

    // 4 queries: session + masterlist + 2 bills. The 3rd getBill throws, and the two
    // bills already in hand are still returned rather than thrown away with it.
    expect(calls.bills).toEqual([1, 2])
    expect(page.records).toHaveLength(2)
  })

  test('no active session is a warning, not a crash', async () => {
    const budget = new MemoryQueryBudget(100)
    const api: LegiScanApi = {
      getSessionList: async () => SESSIONS.filter((s) => s.prior === 1),
      getMasterListRaw: async () => [],
      getBill: async () => ({}),
    }
    const fetcher = new LegiScanFetcher({
      client: api,
      budget,
      knownHashes: async () => new Map(),
      maxBillsPerPoll: 500,
    })

    const page = await fetcher.poll(null)

    expect(page.records).toEqual([])
    expect(page.nextCursor).toBeNull()
  })
})
