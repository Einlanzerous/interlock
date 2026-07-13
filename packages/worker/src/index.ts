import { Pool } from 'pg'
import { PgBoss } from 'pg-boss'
import { parseEnv, type Fetcher } from '@interlock/shared'
import { migrate } from '@interlock/db'
import { readChangeHashes } from './seam/ingest'
import { ensureQueues, registerPipeline } from './seam/pipeline'
import { startScheduler, type ScheduledSource } from './seam/scheduler'
import { ChiClerkClient } from './sources/chi_clerk/client'
import { ChiClerkFetcher } from './sources/chi_clerk/fetcher'
import { PgQueryBudget } from './sources/legiscan_il/budget'
import { LegiScanClient } from './sources/legiscan_il/client'
import { LegiScanFetcher } from './sources/legiscan_il/fetcher'

/**
 * The Interlock worker: migrate → start pg-boss → register the pipeline →
 * schedule fetchers. Everything the fetchers need (staging, queue, cursors,
 * single-flight, backoff) is the ITLK-4 seam; they only implement poll().
 */

const env = parseEnv()
const pool = new Pool({ connectionString: env.DATABASE_URL })
const boss = new PgBoss(env.DATABASE_URL)
boss.on('error', (err) => console.error('[worker] pg-boss error', err))

const fetchers: Fetcher[] = [
  new ChiClerkFetcher({
    client: new ChiClerkClient({
      baseUrl: env.CHI_CLERK_BASE_URL,
      maxRps: env.CHI_CLERK_MAX_RPS,
    }),
    backfillDays: env.CHI_CLERK_BACKFILL_DAYS,
  }),
]

// LegiScan is the only keyed source, and the app must boot without one (ITLK-2):
// no key simply means no Illinois ingest, loudly, rather than a failed start.
if (env.LEGISCAN_API_KEY) {
  const budget = new PgQueryBudget({
    pool,
    source: 'legiscan_il',
    limit: env.LEGISCAN_MONTHLY_QUERY_LIMIT,
  })
  fetchers.push(
    new LegiScanFetcher({
      client: new LegiScanClient({
        apiKey: env.LEGISCAN_API_KEY,
        baseUrl: env.LEGISCAN_BASE_URL,
        state: env.LEGISCAN_STATE,
        maxRps: env.LEGISCAN_MAX_RPS,
        budget,
      }),
      budget,
      // The seam owns persistence; the fetcher reads its resume state through this port.
      knownHashes: () => readChangeHashes(pool, 'legiscan_il', 'bill'),
      maxBillsPerPoll: env.LEGISCAN_MAX_BILLS_PER_POLL,
    }),
  )
} else {
  console.warn('[worker] LEGISCAN_API_KEY is unset — Illinois GA ingest is disabled')
}

async function main(): Promise<void> {
  console.log('[worker] starting Interlock worker')

  const applied = await migrate(pool)
  console.log(
    applied.length > 0
      ? `[worker] migrations applied: ${applied.join(', ')}`
      : '[worker] migrations up to date',
  )

  await boss.start()
  await ensureQueues(boss)
  await registerPipeline(boss, pool)
  console.log('[worker] pipeline consumer registered')

  const sources: ScheduledSource[] = fetchers.map((fetcher) => ({
    fetcher,
    intervalMs:
      fetcher.source === 'chi_clerk'
        ? env.CHI_CLERK_POLL_MINUTES * 60_000
        : env.LEGISCAN_POLL_HOURS * 3_600_000,
  }))
  const scheduler = startScheduler(pool, sources, {
    onError: (source, err) => console.error(`[worker] poll failed for ${source}`, err),
  })
  console.log(
    `[worker] scheduling ${sources.length} fetcher(s): ${fetchers.map((f) => f.source).join(', ')}`,
  )

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[worker] ${signal} received — shutting down`)
    await scheduler.stop()
    await boss.stop({ close: true, timeout: 5_000 })
    await pool.end()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  console.log('[worker] ready')
}

main().catch((err: unknown) => {
  console.error('[worker] fatal', err)
  process.exit(1)
})
