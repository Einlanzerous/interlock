import { Pool } from 'pg'
import { PgBoss } from 'pg-boss'
import { parseEnv, type Fetcher } from '@interlock/shared'
import { migrate } from '@interlock/db'
import { ensureQueues, registerPipeline } from './seam/pipeline'
import { startScheduler, type ScheduledSource } from './seam/scheduler'
import { ChiClerkClient } from './sources/chi_clerk/client'
import { ChiClerkFetcher } from './sources/chi_clerk/fetcher'

/**
 * The Interlock worker: migrate → start pg-boss → register the pipeline →
 * schedule fetchers. Everything the fetchers need (staging, queue, cursors,
 * single-flight, backoff) is the ITLK-4 seam; they only implement poll().
 */

const env = parseEnv()
const pool = new Pool({ connectionString: env.DATABASE_URL })
const boss = new PgBoss(env.DATABASE_URL)
boss.on('error', (err) => console.error('[worker] pg-boss error', err))

// ITLK-6: legiscan_il fetcher @ env.LEGISCAN_POLL_HOURS.
const fetchers: Fetcher[] = [
  new ChiClerkFetcher({
    client: new ChiClerkClient({
      baseUrl: env.CHI_CLERK_BASE_URL,
      maxRps: env.CHI_CLERK_MAX_RPS,
    }),
    backfillDays: env.CHI_CLERK_BACKFILL_DAYS,
  }),
]

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
    sources.length > 0
      ? `[worker] scheduling ${sources.length} fetcher(s)`
      : '[worker] no fetchers registered yet (ITLK-5/6) — pipeline is idle but live',
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
