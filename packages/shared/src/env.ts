import { z } from 'zod'

/**
 * The single source of runtime configuration, validated once at process start.
 * Both the Nuxt server and the worker parse the same schema so a misconfigured
 * box fails fast in one place instead of surfacing as a mystery later.
 */
export const envSchema = z.object({
  // Postgres is the source of truth, the queue, and the search index.
  DATABASE_URL: z.string().url(),

  // Illinois GA ingest (ITLK-6). Optional so the app boots before a key exists.
  LEGISCAN_API_KEY: z.string().optional(),
  // Open States v3 fallback for IL (ITLK-6).
  OPENSTATES_API_KEY: z.string().optional(),

  // Email alerts (ITLK-8). Absent = in-app feed only, which must still work.
  SMTP_URL: z.string().optional(),
  ALERT_EMAIL_TO: z.string().email().optional(),

  // Poll cadence (ITLK-4/5/6). Chicago source is the Clerk's eLMS — the city
  // left Legistar in June 2023.
  CHI_CLERK_POLL_MINUTES: z.coerce.number().int().positive().default(30),
  LEGISCAN_POLL_HOURS: z.coerce.number().int().positive().default(4),

  // Chicago eLMS fetcher (ITLK-5). Public API, no key.
  CHI_CLERK_BASE_URL: z.string().url().default('https://api.chicityclerkelms.chicago.gov'),
  // Initial-poll bound: only ingest matters published within this many days on
  // the first poll, so a fresh box doesn't backfill all ~179k archived matters.
  CHI_CLERK_BACKFILL_DAYS: z.coerce.number().int().positive().default(30),
  // Self-imposed rate cap — eLMS publishes no SLA (US-gov Azure). Brief says ≤2/s.
  CHI_CLERK_MAX_RPS: z.coerce.number().positive().default(2),

  WEB_PORT: z.coerce.number().int().positive().default(3000),
})

export type Env = z.infer<typeof envSchema>

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source)
}
