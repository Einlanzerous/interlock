import type { Pool } from 'pg'
import type { Source } from '@interlock/shared'

/**
 * LegiScan query budget (ITLK-6).
 *
 * The free tier is ~30,000 queries a month, and the 104th GA alone holds 12,022
 * bills — so a cold-start backfill can spend 40% of a month's budget before it is
 * caught up. That makes the budget a real constraint rather than a formality, and
 * it has to be *durable*: an in-process counter would reset on every worker restart
 * and cheerfully spend the cap several times over.
 *
 * It is modeled as a port, not a table reference, because the Fetcher seam says
 * fetchers do HTTP and shaping and never touch app tables (docs/fetcher-seam.md).
 * The fetcher depends on this interface; the worker wires the Postgres implementation
 * below. A Go ingester implements the same two statements against the same table and
 * the accounting stays correct across both.
 */

export interface BudgetUsage {
  /** Queries spent in the current period. */
  used: number
  /** Ceiling for the period. */
  limit: number
  /** `limit - used`, floored at 0. */
  remaining: number
}

export interface QueryBudget {
  /** Record `n` spent queries and return the resulting usage. */
  spend(n: number): Promise<BudgetUsage>
  /** Read usage without spending. */
  usage(): Promise<BudgetUsage>
}

/** Thrown when a request would exceed the period cap. Ends the poll; never retried into the wall. */
export class BudgetExhaustedError extends Error {
  constructor(readonly usage: BudgetUsage) {
    super(
      `[legiscan_il] monthly query budget exhausted (${usage.used}/${usage.limit}) — ` +
        `no further queries until the next period`,
    )
    this.name = 'BudgetExhaustedError'
  }
}

/** Warn once per poll when usage crosses this share of the cap. */
const WARN_AT = 0.8

/** Period key: LegiScan's cap is calendar-monthly, so the UTC month is the bucket. */
export function periodOf(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

export interface PgQueryBudgetOptions {
  pool: Pool
  source: Source
  limit: number
  now?: () => Date
}

/**
 * Postgres-backed budget. The increment is a single upsert returning the new total,
 * so concurrent pollers (or a Go ingester alongside this one) can't both read the
 * same pre-spend total and overspend the cap.
 */
export class PgQueryBudget implements QueryBudget {
  private readonly pool: Pool
  private readonly source: Source
  private readonly limit: number
  private readonly now: () => Date
  private warned = false

  constructor(opts: PgQueryBudgetOptions) {
    this.pool = opts.pool
    this.source = opts.source
    this.limit = opts.limit
    this.now = opts.now ?? ((): Date => new Date())
  }

  async spend(n: number): Promise<BudgetUsage> {
    const { rows } = await this.pool.query<{ queries: number }>(
      `insert into api_budget (source, period, queries)
       values ($1, $2, $3)
       on conflict (source, period) do update set queries = api_budget.queries + excluded.queries
       returning queries`,
      [this.source, periodOf(this.now()), n],
    )
    return this.report(Number(rows[0]!.queries))
  }

  async usage(): Promise<BudgetUsage> {
    const { rows } = await this.pool.query<{ queries: number }>(
      `select queries from api_budget where source = $1 and period = $2`,
      [this.source, periodOf(this.now())],
    )
    return this.report(Number(rows[0]?.queries ?? 0))
  }

  private report(used: number): BudgetUsage {
    const usage = { used, limit: this.limit, remaining: Math.max(0, this.limit - used) }
    if (!this.warned && used >= this.limit * WARN_AT) {
      this.warned = true
      console.warn(
        `[legiscan_il] query budget at ${used}/${this.limit} ` +
          `(${Math.round((used / this.limit) * 100)}%) for ${periodOf(this.now())}`,
      )
    }
    return usage
  }
}

/** In-memory budget for tests and for a box that would rather not persist accounting. */
export class MemoryQueryBudget implements QueryBudget {
  private used = 0
  constructor(private readonly limit: number) {}

  async spend(n: number): Promise<BudgetUsage> {
    this.used += n
    return this.usage()
  }

  async usage(): Promise<BudgetUsage> {
    return { used: this.used, limit: this.limit, remaining: Math.max(0, this.limit - this.used) }
  }
}
