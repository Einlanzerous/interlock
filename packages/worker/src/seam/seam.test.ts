import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { PgBoss } from 'pg-boss'
import { migrate } from '@interlock/db'
import { PROCESS_RECORD_QUEUE, type Fetcher, type FetchPage } from '@interlock/shared'
import { commitPage, readCursor } from './ingest'
import { ensureQueues, registerPipeline, type StagedRecord } from './pipeline'
import { runSourceOnce } from './scheduler'

/**
 * ITLK-4 acceptance criteria, run against a real Postgres (throwaway DB per
 * run, same pattern as @interlock/db). Set DATABASE_URL; CI provides it.
 */

const adminUrl = process.env.DATABASE_URL
if (!adminUrl) {
  console.warn('[seam test] DATABASE_URL not set — skipping seam integration tests')
}

const TEST_DB = `interlock_seam_${randomUUID().slice(0, 8)}`

let adminPool: Pool
let pool: Pool
let boss: PgBoss

/** A record the fake fetchers emit; payload marks which page it came from. */
function rec(n: number, page: string) {
  return { sourceId: `matter-${n}`, kind: 'matter', payload: { n, page }, changeHash: null }
}

describe.skipIf(!adminUrl)('fetcher seam', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl, max: 1 })
    await adminPool.query(`create database ${TEST_DB}`)
    const testUrl = new URL(adminUrl!)
    testUrl.pathname = `/${TEST_DB}`
    pool = new Pool({ connectionString: testUrl.toString(), max: 4 })
    await migrate(pool)
    boss = new PgBoss(testUrl.toString())
    boss.on('error', () => {})
    await boss.start()
    await ensureQueues(boss)
  })

  afterAll(async () => {
    await boss?.stop({ close: true, timeout: 2_000 })
    await pool?.end()
    await adminPool?.query(`drop database if exists ${TEST_DB} with (force)`)
    await adminPool?.end()
  })

  test('N records → N source_record rows + N jobs, consumed by the pipeline stub', async () => {
    // 3 + 2 records over two pages, then a caught-up empty page.
    const fetcher: Fetcher = {
      source: 'chi_clerk',
      async poll(cursor): Promise<FetchPage> {
        if (cursor === null) return { records: [rec(1, 'p1'), rec(2, 'p1'), rec(3, 'p1')], nextCursor: 'p2' }
        if (cursor === 'p2') return { records: [rec(4, 'p2'), rec(5, 'p2')], nextCursor: 'p3' }
        return { records: [], nextCursor: null }
      },
    }

    const outcome = await runSourceOnce(pool, fetcher)
    expect(outcome).toEqual({ status: 'ran', pages: 3, records: 5 })

    const rows = await pool.query(`select count(*)::int as n from source_record`)
    expect(rows.rows[0]!.n).toBe(5)
    const jobs = await pool.query(
      `select count(*)::int as n from pgboss.job where name = $1`,
      [PROCESS_RECORD_QUEUE],
    )
    expect(jobs.rows[0]!.n).toBe(5)
    expect(await readCursor(pool, 'chi_clerk')).toBe('p3')

    // The consumer stub sees every staged record.
    const seen: StagedRecord[] = []
    await registerPipeline(boss, pool, async (record) => {
      seen.push(record)
    })
    const deadline = Date.now() + 15_000
    while (seen.length < 5 && Date.now() < deadline) await Bun.sleep(100)
    expect(seen.length).toBe(5)
    expect(new Set(seen.map((r) => r.sourceId)).size).toBe(5)
    expect(seen[0]!.source).toBe('chi_clerk')

    // ...and pg-boss marks the jobs completed, not silently dropped.
    let completed = 0
    const settled = Date.now() + 15_000
    while (completed < 5 && Date.now() < settled) {
      const { rows: s } = await pool.query<{ n: number }>(
        `select count(*)::int as n from pgboss.job where name = $1 and state = 'completed'`,
        [PROCESS_RECORD_QUEUE],
      )
      completed = s[0]!.n
      if (completed < 5) await Bun.sleep(100)
    }
    expect(completed).toBe(5)
  })

  test('mid-page crash: cursor stays put, restart resumes without duplicates', async () => {
    // Page 1 commits; page 2 explodes mid-commit (bad record violates NOT NULL
    // inside the transaction) — the whole page must roll back.
    let phase: 'crashy' | 'fixed' = 'crashy'
    const fetcher: Fetcher = {
      source: 'legiscan_il',
      async poll(cursor): Promise<FetchPage> {
        if (cursor === null) return { records: [rec(10, 'p1'), rec(11, 'p1')], nextCursor: 'w1' }
        if (cursor === 'w1') {
          if (phase === 'crashy') {
            return {
              records: [rec(12, 'p2'), { sourceId: 'matter-13', kind: '', payload: {}, changeHash: null }],
              nextCursor: 'w2',
            }
          }
          return { records: [rec(12, 'p2'), rec(13, 'p2')], nextCursor: 'w2' }
        }
        return { records: [], nextCursor: null }
      },
    }

    await expect(runSourceOnce(pool, fetcher)).rejects.toThrow()

    // Page 1 landed; the crashed page left nothing — cursor still at w1.
    const afterCrash = await pool.query(
      `select count(*)::int as n from source_record where source = 'legiscan_il'`,
    )
    expect(afterCrash.rows[0]!.n).toBe(2)
    expect(await readCursor(pool, 'legiscan_il')).toBe('w1')

    // Restart with the poison record fixed: resumes from w1, no duplicates.
    phase = 'fixed'
    const retry = await runSourceOnce(pool, fetcher)
    expect(retry).toEqual({ status: 'ran', pages: 2, records: 2 })
    const afterRetry = await pool.query(
      `select count(*)::int as n, count(distinct source_id)::int as distinct_n
       from source_record where source = 'legiscan_il'`,
    )
    expect(afterRetry.rows[0]!.n).toBe(4)
    expect(afterRetry.rows[0]!.distinct_n).toBe(4)
    expect(await readCursor(pool, 'legiscan_il')).toBe('w2')
  })

  test('two overlapping polls of one source: single-flight, one skips', async () => {
    const slowFetcher: Fetcher = {
      source: 'chi_clerk',
      async poll(): Promise<FetchPage> {
        await Bun.sleep(300)
        return { records: [], nextCursor: null }
      },
    }
    const [a, b] = await Promise.all([
      runSourceOnce(pool, slowFetcher),
      runSourceOnce(pool, slowFetcher),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual(['ran', 'skipped'])
  })

  test('commitPage rejects malformed fetcher output before touching the DB', async () => {
    await expect(
      commitPage(pool, 'chi_clerk', {
        records: [{ sourceId: '', kind: 'matter', payload: {} }],
        nextCursor: 'x',
      }),
    ).rejects.toThrow()
    // Nothing landed and the cursor did not move to 'x'.
    expect(await readCursor(pool, 'chi_clerk')).toBe('p3')
  })
})
