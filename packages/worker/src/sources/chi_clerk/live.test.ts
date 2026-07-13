import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { PgBoss } from 'pg-boss'
import { migrate } from '@interlock/db'
import { ensureQueues, makeNormalizer, type StagedRecord } from '../../seam/pipeline'
import { runSourceOnce } from '../../seam/scheduler'
import { ChiClerkClient } from './client'
import { ChiClerkFetcher } from './fetcher'

/**
 * ITLK-5 live acceptance — the real thing, against the real City Clerk API.
 *
 * Gated behind CHI_CLERK_LIVE=1 because it hits the network and takes a couple of
 * minutes at the 2 req/s self-cap. It is the ticket's headline criteria, run for
 * real rather than against fixtures:
 *
 *   1. A bounded poll yields canonical bills with actions, sponsors, committee refs
 *      and raw payloads — with zero adapter exceptions.
 *   2. An immediate re-poll with no upstream change writes zero rows.
 *
 * Run it with:
 *   CHI_CLERK_LIVE=1 bun test packages/worker/src/sources/chi_clerk/live.test.ts
 */

const adminUrl = process.env.DATABASE_URL
const live = process.env.CHI_CLERK_LIVE === '1' && !!adminUrl

/** Days of matters to ingest. The Clerk publishes in bursts; 2 days is ~180 matters. */
const BACKFILL_DAYS = Number(process.env.CHI_CLERK_BACKFILL_DAYS ?? 2)

const TEST_DB = `interlock_live_${randomUUID().slice(0, 8)}`

let adminPool: Pool
let pool: Pool
let boss: PgBoss

/** Normalize every staged record the way pg-boss would, counting failures. */
async function drainStaging(from = 0): Promise<{ processed: number; failures: string[] }> {
  const normalize = makeNormalizer(pool)
  const { rows } = await pool.query(
    `select id, source, source_id, kind, payload, change_hash
     from source_record where id > $1 order by id`,
    [from],
  )
  const failures: string[] = []
  for (const row of rows) {
    const record: StagedRecord = {
      id: Number(row.id),
      source: row.source,
      sourceId: row.source_id,
      kind: row.kind,
      payload: row.payload,
      changeHash: row.change_hash,
    }
    try {
      await normalize(record)
    } catch (err) {
      failures.push(`${record.kind}/${record.sourceId}: ${String(err)}`)
    }
  }
  return { processed: rows.length, failures }
}

const counts = async (): Promise<Record<string, number>> => {
  const { rows } = await pool.query<Record<string, number>>(
    `select (select count(*) from bill)::int         as bill,
            (select count(*) from bill_action)::int  as bill_action,
            (select count(*) from sponsorship)::int  as sponsorship,
            (select count(*) from official)::int     as official,
            (select count(*) from committee)::int    as committee,
            (select count(*) from membership)::int   as membership,
            (select count(*) from source_record)::int as source_record`,
  )
  return rows[0]!
}

describe.skipIf(!live)('chi_clerk live ingest', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl, max: 1 })
    await adminPool.query(`create database ${TEST_DB}`)
    const testUrl = new URL(adminUrl!)
    testUrl.pathname = `/${TEST_DB}`
    pool = new Pool({ connectionString: testUrl.toString(), max: 4 })
    await migrate(pool)
    // The seam enqueues by direct INSERT into pgboss.job, so the queue has to exist:
    // boot pg-boss exactly as the worker does at startup.
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

  test(
    'a bounded live poll fills the canonical model, and an immediate re-poll writes nothing',
    async () => {
      const fetcher = new ChiClerkFetcher({
        client: new ChiClerkClient({
          baseUrl: process.env.CHI_CLERK_BASE_URL ?? 'https://api.chicityclerkelms.chicago.gov',
          maxRps: 2, // the brief's self-cap; eLMS publishes no rate limit
        }),
        backfillDays: BACKFILL_DAYS,
      })

      // --- Poll 1: the real seam path (staging + enqueue + cursor, one tx per page).
      const first = await runSourceOnce(pool, fetcher)
      expect(first.status).toBe('ran')
      console.log(`[live] poll 1: ${JSON.stringify(first)}`)

      const drained = await drainStaging()
      // "Zero adapter exceptions" — the acceptance criterion, stated literally.
      expect(drained.failures).toEqual([])
      expect(drained.processed).toBeGreaterThan(0)

      const after = await counts()
      console.log('[live] canonical counts:', after)

      // Bills, with real history and real sponsors.
      expect(after.bill).toBeGreaterThan(0)
      expect(after.bill_action).toBeGreaterThan(0)
      expect(after.sponsorship).toBeGreaterThan(0)
      // The officials/committees seed that ITLK-7 and ITLK-9 build on.
      expect(after.official).toBeGreaterThan(0)
      expect(after.committee).toBeGreaterThan(0)
      expect(after.membership).toBeGreaterThan(0)

      // Every bill kept its verbatim payload and a resolvable status.
      const sanity = await pool.query<{ n: number }>(
        `select count(*)::int as n from bill
         where raw is null or title = '' or identifier = ''`,
      )
      expect(sanity.rows[0]!.n).toBe(0)

      // Committee refs landed as referral actions (real or synthesized).
      const referrals = await pool.query<{ n: number }>(
        `select count(*)::int as n from bill_action where classification = 'referred'`,
      )
      expect(referrals.rows[0]!.n).toBeGreaterThan(0)

      // A bill that actually has both actions and sponsors — the full chain.
      const complete = await pool.query<{ n: number }>(
        `select count(*)::int as n from bill b
         where exists (select 1 from bill_action a where a.bill_id = b.id)
           and exists (select 1 from sponsorship s where s.bill_id = b.id)`,
      )
      expect(complete.rows[0]!.n).toBeGreaterThan(0)

      // How much of the status vocabulary did we actually resolve?
      const statuses = await pool.query(
        `select status, count(*)::int as n from bill group by status order by n desc`,
      )
      console.log('[live] statuses:', statuses.rows)

      // --- Poll 2: immediately again, nothing changed upstream.
      const stagedBefore = after.source_record
      const second = await runSourceOnce(pool, fetcher)
      console.log(`[live] poll 2: ${JSON.stringify(second)}`)
      if (second.status !== 'ran') throw new Error(`poll 2 did not run: ${second.status}`)

      // The watermark holds: the fetcher re-stages nothing...
      const afterSecond = await counts()
      expect(afterSecond.source_record).toBe(stagedBefore)
      expect(second.records).toBe(0)

      // ...and re-normalizing everything that IS staged writes zero canonical rows.
      const renormalized = await drainStaging()
      expect(renormalized.failures).toEqual([])
      const final = await counts()
      expect(final).toEqual(after)
    },
    10 * 60_000,
  )
})
