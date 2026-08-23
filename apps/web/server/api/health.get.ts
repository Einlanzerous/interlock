import { resolveBuildIdentity } from '@interlock/shared'
import { Pool } from 'pg'

/**
 * Liveness + database connectivity probe. The worker owns polling; the web
 * server just needs to confirm it can reach Postgres. Reused by the dashboard
 * and by deploy healthchecks (ITLK-13).
 *
 * ── Also the build-identity contract (ITLK-32) ─────────────────────────────
 *
 * Switchyard's delivery reconciler polls this endpoint and reads `version` +
 * `sha` to record what is actually running — the observed half of the estate's
 * delivery ledger (SWY-192). Interlock registers with `health_path=/api/health`
 * rather than the estate-default `/healthz`, deliberately: `/healthz` is a PAGE
 * route here, so it falls through to the SPA and answers a 302 to `/login`,
 * which the reconciler classifies as `unreachable`. Registering against that
 * path would paint a healthy service red.
 *
 * This route is in `PUBLIC_API` (server/middleware/auth.ts) and must stay
 * there — the reconciler carries no credentials.
 *
 * The identity is reported on every branch below, including the failure ones.
 * A degraded service is still running a version, and it is the one most worth
 * identifying; dropping it when the database is down would blind the ledger to
 * exactly the services that need looking at.
 */

type DbState = 'up' | 'down' | 'unconfigured'

interface Health {
  ok: boolean
  db: DbState
  now: string | null
  error: string | null
  /** Bare semver or the literal `dev`. Never a `v` prefix — see build-identity. */
  version: string
  /** Full 40-char commit, or null. Never abbreviated. */
  sha: string | null
}

let pool: Pool | undefined

export default defineEventHandler(async (): Promise<Health> => {
  const build = resolveBuildIdentity()
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    return { ok: false, db: 'unconfigured', now: null, error: null, ...build }
  }

  pool ??= new Pool({ connectionString })

  try {
    const { rows } = await pool.query<{ now: Date }>('select now() as now')
    return {
      ok: true,
      db: 'up',
      now: rows[0]?.now.toISOString() ?? null,
      error: null,
      ...build,
    }
  } catch (err) {
    return {
      ok: false,
      db: 'down',
      now: null,
      error: err instanceof Error ? err.message : String(err),
      ...build,
    }
  }
})
