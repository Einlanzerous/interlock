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

  // LegiScan fetcher (ITLK-6). Metered: the free tier is ~30k queries/month.
  LEGISCAN_BASE_URL: z.string().url().default('https://api.legiscan.com'),
  LEGISCAN_STATE: z.string().length(2).default('IL'),
  // Monthly query cap. Accounted durably in `api_budget`, so a worker restart can't
  // reset the counter and spend the tier twice.
  LEGISCAN_MONTHLY_QUERY_LIMIT: z.coerce.number().int().positive().default(30_000),
  // Bills fetched per poll. Bounds a cold start: the 104th GA holds 12,022 bills, so
  // an uncapped first poll would spend ~40% of the month's budget in one burst.
  LEGISCAN_MAX_BILLS_PER_POLL: z.coerce.number().int().positive().default(500),
  // Self-imposed rate cap — LegiScan publishes a monthly quota but no rate limit.
  LEGISCAN_MAX_RPS: z.coerce.number().positive().default(2),

  // Chicago eLMS fetcher (ITLK-5). Public API, no key.
  CHI_CLERK_BASE_URL: z.string().url().default('https://api.chicityclerkelms.chicago.gov'),
  // Initial-poll bound: only ingest matters published within this many days on
  // the first poll, so a fresh box doesn't backfill all ~179k archived matters.
  CHI_CLERK_BACKFILL_DAYS: z.coerce.number().int().positive().default(30),
  // Self-imposed rate cap — eLMS publishes no SLA (US-gov Azure). Brief says ≤2/s.
  CHI_CLERK_MAX_RPS: z.coerce.number().positive().default(2),

  // Sponsor → Official matching (ITLK-7). The brief flags this as a number we should
  // expect to tune, so it is configuration rather than a constant in the matcher.
  // At or above this pg_trgm similarity a name match auto-links; below it, a human
  // resolves it from the review queue.
  MATCH_NAME_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),

  WEB_PORT: z.coerce.number().int().positive().default(3000),
})

export type Env = z.infer<typeof envSchema>

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source)
}
