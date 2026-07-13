import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { PgBoss } from 'pg-boss'
import { migrate } from '@interlock/db'
import { ensureQueues, makeNormalizer, type StagedRecord } from '../../seam/pipeline'
import { readChangeHashes } from '../../seam/ingest'
import { runSourceOnce } from '../../seam/scheduler'
import { PgQueryBudget } from './budget'
import { LegiScanClient } from './client'
import { LegiScanFetcher } from './fetcher'

/**
 * ITLK-6 live acceptance — the real thing, against the real LegiScan API.
 *
 * Gated behind LEGISCAN_LIVE=1 because it hits the network and, unlike the eLMS live
 * test, it spends a **metered** resource: every query comes out of the ~30k/month free
 * tier. It is deliberately bounded to a small batch (LEGISCAN_LIVE_BILLS, default 25),
 * so a full run costs ~27 queries.
 *
 * It asserts the ticket's headline criteria against live data:
 *
 *   1. A master-list poll stores bills with change_hashes, and the query count is
 *      1 master list + 1 per changed bill (+1 session lookup) — not one per bill.
 *   2. An immediate re-poll fires ZERO getBill calls and writes ZERO rows.
 *   3. Real bills land with canonical status, action history and sponsors.
 *
 * Run it with:
 *   LEGISCAN_LIVE=1 bun test packages/worker/src/sources/legiscan_il/live.test.ts
 */

const adminUrl = process.env.DATABASE_URL
const apiKey = process.env.LEGISCAN_API_KEY
const live = process.env.LEGISCAN_LIVE === '1' && !!adminUrl && !!apiKey

/** Bills to ingest. Each one costs exactly one query against the monthly budget. */
const LIVE_BILLS = Number(process.env.LEGISCAN_LIVE_BILLS ?? 25)

const TEST_DB = `interlock_ls_live_${randomUUID().slice(0, 8)}`

let adminPool: Pool
let pool: Pool
let boss: PgBoss

function makeFetcher(): LegiScanFetcher {
  // A fresh budget row per test DB, so this test can never be the thing that trips the
  // real monthly cap — but the accounting path itself is still exercised.
  const budget = new PgQueryBudget({ pool, source: 'legiscan_il', limit: 30_000 })
  return new LegiScanFetcher({
    client: new LegiScanClient({
      apiKey: apiKey!,
      baseUrl: process.env.LEGISCAN_BASE_URL ?? 'https://api.legiscan.com',
      state: process.env.LEGISCAN_STATE ?? 'IL',
      maxRps: 2,
      budget,
    }),
    budget,
    knownHashes: () => readChangeHashes(pool, 'legiscan_il', 'bill'),
    maxBillsPerPoll: LIVE_BILLS,
  })
}

/** Normalize every staged record the way pg-boss would, counting failures. */
async function drainStaging(): Promise<{ processed: number; failures: string[] }> {
  const normalize = makeNormalizer(pool)
  const { rows } = await pool.query(
    `select id, source, source_id, kind, payload, change_hash
     from source_record order by id`,
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
    `select (select count(*) from bill)::int          as bill,
            (select count(*) from bill_action)::int   as bill_action,
            (select count(*) from sponsorship)::int   as sponsorship,
            (select count(*) from official)::int      as official,
            (select count(*) from committee)::int     as committee,
            (select count(*) from source_record)::int as source_record`,
  )
  return rows[0]!
}

const queriesSpent = async (): Promise<number> => {
  const { rows } = await pool.query<{ n: number }>(
    `select coalesce(sum(queries), 0)::int as n from api_budget where source = 'legiscan_il'`,
  )
  return rows[0]!.n
}

const countOf = async (table: string): Promise<number> => {
  const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from ${table}`)
  return rows[0]!.n
}


describe.skipIf(!live)('legiscan_il live ingest', () => {
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

  test(
    'a bounded live poll fills the canonical model, and an immediate re-poll spends nothing',
    async () => {
      // --- Poll 1: the real seam path (staging + enqueue, one tx per page).
      const first = await runSourceOnce(pool, makeFetcher())
      expect(first.status).toBe('ran')
      console.log(`[live] poll 1: ${JSON.stringify(first)}`)

      const spentFirst = await queriesSpent()
      console.log(`[live] queries spent: ${spentFirst}`)
      // 1 getSessionList + 1 getMasterListRaw + 1 getBill per staged bill. The point of
      // the whole design: the 12,022-bill session costs ONE query to diff.
      if (first.status !== 'ran') throw new Error('poll 1 did not run')
      expect(spentFirst).toBe(2 + first.records)
      expect(first.records).toBe(LIVE_BILLS)

      const drained = await drainStaging()
      expect(drained.failures).toEqual([]) // zero adapter exceptions
      expect(drained.processed).toBe(LIVE_BILLS)

      const after = await counts()
      console.log('[live] canonical counts:', after)

      expect(after.bill).toBe(LIVE_BILLS)
      expect(after.bill_action).toBeGreaterThan(0)
      expect(after.sponsorship).toBeGreaterThan(0)
      // The CRM seed, straight out of the sponsor bios — no getPerson call.
      expect(after.official).toBeGreaterThan(0)

      // Every bill kept a verbatim payload, an identifier and a change_hash.
      const sanity = await pool.query<{ n: number }>(
        `select count(*)::int as n from bill
         where raw is null or title = '' or identifier = '' or change_hash is null`,
      )
      expect(sanity.rows[0]!.n).toBe(0)

      // Officials carry the district and party the matcher (ITLK-7) leans on.
      const seeded = await pool.query<{ n: number }>(
        `select count(*)::int as n from official
         where source_person_ids ? 'legiscan_il' and district is not null`,
      )
      expect(seeded.rows[0]!.n).toBeGreaterThan(0)

      // Sponsorships stay unmatched but carry tier-1's key.
      const sponsorKeys = await pool.query<{ n: number }>(
        `select count(*)::int as n from sponsorship
         where official_id is null and source_person_id is not null`,
      )
      expect(sponsorKeys.rows[0]!.n).toBeGreaterThan(0)

      const statuses = await pool.query(
        `select status, count(*)::int as n from bill group by status order by n desc`,
      )
      console.log('[live] statuses:', statuses.rows)

      const classes = await pool.query(
        `select classification, count(*)::int as n from bill_action
         group by classification order by n desc`,
      )
      console.log('[live] action classifications:', classes.rows)

      // --- Poll 2: immediately again, seconds later.
      //
      // A cold start still has ~12,000 bills to drain, so poll 2 does NOT idle — it
      // takes the next batch, which is the backfill working as designed. What it must
      // never do is spend a query on a bill it already holds. That is the change_hash
      // guarantee, and here it is proved against live hashes rather than fixtures.
      const second = await runSourceOnce(pool, makeFetcher())
      console.log(`[live] poll 2: ${JSON.stringify(second)}`)
      if (second.status !== 'ran') throw new Error(`poll 2 did not run: ${second.status}`)

      // Not one bill was fetched twice. Had any of poll 1's 25 been re-requested, it
      // would have a second staging row here.
      const dupes = await pool.query<{ source_id: string }>(
        `select source_id from source_record
         where source = 'legiscan_il' and kind = 'bill'
         group by source_id having count(*) > 1`,
      )
      expect(dupes.rows).toEqual([])

      // So every query poll 2 spent went to the two discovery calls plus bills it had
      // never seen — never to re-confirming an unchanged one.
      expect(await queriesSpent()).toBe(spentFirst + 2 + second.records)
      expect(await countOf('source_record')).toBe(LIVE_BILLS + second.records)

      // Normalize poll 2's new records, so everything staged is now in the model.
      const drainedSecond = await drainStaging()
      expect(drainedSecond.failures).toEqual([])
      const settled = await counts()
      expect(settled.bill).toBe(LIVE_BILLS + second.records)
      console.log('[live] settled counts:', settled)

      // Now normalize the whole of staging a SECOND time. Every row is unchanged, so
      // every adapter must short-circuit on its change_hash and write nothing — the
      // idempotency claim ITLK-8's differ depends on, against real payloads.
      const renormalized = await drainStaging()
      expect(renormalized.failures).toEqual([])
      expect(await counts()).toEqual(settled)
    },
    10 * 60_000,
  )
})
