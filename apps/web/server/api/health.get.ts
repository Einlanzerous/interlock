import { Pool } from 'pg'

/**
 * Liveness + database connectivity probe. The worker owns polling; the web
 * server just needs to confirm it can reach Postgres. Reused by the dashboard
 * and by deploy healthchecks (ITLK-13).
 */

type DbState = 'up' | 'down' | 'unconfigured'

interface Health {
  ok: boolean
  db: DbState
  now: string | null
  error: string | null
}

let pool: Pool | undefined

export default defineEventHandler(async (): Promise<Health> => {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    return { ok: false, db: 'unconfigured', now: null, error: null }
  }

  pool ??= new Pool({ connectionString })

  try {
    const { rows } = await pool.query<{ now: Date }>('select now() as now')
    return { ok: true, db: 'up', now: rows[0]?.now.toISOString() ?? null, error: null }
  } catch (err) {
    return {
      ok: false,
      db: 'down',
      now: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
})
