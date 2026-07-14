import { Pool } from 'pg'

/**
 * One Postgres pool for the whole Nitro server, created lazily.
 *
 * Nitro reloads route modules in dev; a pool created at module scope in each route would
 * leak a connection pool per reload, so the pool is memoized here and shared.
 */
let pool: Pool | undefined

export function db(): Pool {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw createError({ statusCode: 500, statusMessage: 'DATABASE_URL is not configured' })
  }
  pool ??= new Pool({ connectionString })
  return pool
}

/** The auto-link threshold, shared with the worker so the UI never contradicts ingest. */
export function matchThreshold(): number {
  const raw = Number(process.env.MATCH_NAME_SIMILARITY_THRESHOLD)
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.85
}
