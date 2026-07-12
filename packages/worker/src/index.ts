import { Pool } from 'pg'
import { parseEnv, signalColor } from '@interlock/shared'

/**
 * The Interlock worker. Today it does nothing but prove the seam: parse the
 * shared env, connect to Postgres, and stay up with a heartbeat. The fetcher
 * scheduler and the normalize/match/diff/alert consumers land in ITLK-4+.
 */

const env = parseEnv()
const pool = new Pool({ connectionString: env.DATABASE_URL })

let shuttingDown = false

async function ping(): Promise<Date> {
  const { rows } = await pool.query<{ now: Date }>('select now() as now')
  return rows[0]!.now
}

async function waitForDatabase(): Promise<void> {
  for (let attempt = 1; !shuttingDown; attempt++) {
    try {
      const now = await ping()
      console.log(`[worker] connected to Postgres at ${now.toISOString()}`)
      return
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[worker] Postgres not ready (attempt ${attempt}): ${message} — retrying in 3s`)
      await Bun.sleep(3000)
    }
  }
}

async function main(): Promise<void> {
  console.log('[worker] starting Interlock worker')
  // Exercise the shared package at runtime so the edge-to-edge import is real,
  // not just a type-only reference.
  console.log(`[worker] signal palette loaded (watch=${signalColor('watch')})`)

  await waitForDatabase()
  if (shuttingDown) return

  const heartbeat = setInterval(() => {
    ping().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[worker] heartbeat failed: ${message}`)
    })
  }, 30_000)

  const shutdown = async (signal: string): Promise<void> => {
    shuttingDown = true
    console.log(`[worker] ${signal} received — shutting down`)
    clearInterval(heartbeat)
    await pool.end()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  console.log('[worker] ready — heartbeat every 30s (Ctrl-C to stop)')
}

main().catch((err: unknown) => {
  console.error('[worker] fatal', err)
  process.exit(1)
})
