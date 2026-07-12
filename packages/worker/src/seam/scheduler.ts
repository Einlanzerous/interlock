import type { Pool } from 'pg'
import type { Fetcher } from '@interlock/shared'
import { commitPage, readCursor } from './ingest'

/**
 * Advisory-lock namespace for per-source poll single-flight (two-int form:
 * this class id + a hash of the source name). Shared with any non-TS ingester
 * — a Go binary takes the same lock so two pollers of one source never race,
 * even across processes and languages.
 */
export const SEAM_LOCK_CLASS = 4_540_004 // "itlk-4"

function hash31(text: string): number {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) & 0x7fffffff
  return h
}

export function sourceLockKey(source: string): [number, number] {
  return [SEAM_LOCK_CLASS, hash31(source)]
}

export type PollOutcome =
  | { status: 'skipped' } // another poller holds the source lock
  | { status: 'ran'; pages: number; records: number }

/**
 * One full poll of a source: take the single-flight lock (or bail), then
 * poll → commit page-by-page until the fetcher reports no new records.
 * Each page commits atomically (see commitPage), so a crash mid-run leaves
 * the cursor exactly at the last fully-committed page.
 */
export async function runSourceOnce(pool: Pool, fetcher: Fetcher): Promise<PollOutcome> {
  const [classId, objId] = sourceLockKey(fetcher.source)
  const client = await pool.connect()
  try {
    const {
      rows: [lock],
    } = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock($1, $2) as locked',
      [classId, objId],
    )
    if (!lock!.locked) return { status: 'skipped' }
    try {
      let cursor = await readCursor(pool, fetcher.source)
      let pages = 0
      let records = 0
      for (;;) {
        const page = await fetcher.poll(cursor)
        await commitPage(pool, fetcher.source, page)
        pages += 1
        records += page.records.length
        // Empty page = caught up; unchanged cursor = no way to make progress.
        if (page.records.length === 0 || page.nextCursor === null || page.nextCursor === cursor) {
          break
        }
        cursor = page.nextCursor
      }
      return { status: 'ran', pages, records }
    } finally {
      await client.query('select pg_advisory_unlock($1, $2)', [classId, objId]).catch(() => {})
    }
  } finally {
    client.release()
  }
}

export interface ScheduledSource {
  fetcher: Fetcher
  intervalMs: number
}

export interface SchedulerOptions {
  onError?: (source: string, err: unknown) => void
  /** First retry delay after a failed poll; doubles per consecutive failure. */
  baseBackoffMs?: number
  maxBackoffMs?: number
}

function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

/**
 * Per-source poll loops: run, sleep the source's interval, repeat — with
 * exponential backoff on failure (429/5xx from the source surface here as
 * thrown poll errors). In-process overlap is impossible by construction
 * (sequential loop); cross-process overlap is stopped by the advisory lock.
 */
export function startScheduler(
  pool: Pool,
  sources: ScheduledSource[],
  options: SchedulerOptions = {},
): { stop(): Promise<void> } {
  const { onError, baseBackoffMs = 1_000, maxBackoffMs = 300_000 } = options
  const controller = new AbortController()

  const loops = sources.map(async ({ fetcher, intervalMs }) => {
    let backoffMs = baseBackoffMs
    while (!controller.signal.aborted) {
      let waitMs = intervalMs
      try {
        await runSourceOnce(pool, fetcher)
        backoffMs = baseBackoffMs
      } catch (err) {
        onError?.(fetcher.source, err)
        waitMs = backoffMs
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
      }
      await interruptibleSleep(waitMs, controller.signal)
    }
  })

  return {
    async stop(): Promise<void> {
      controller.abort()
      await Promise.allSettled(loops)
    },
  }
}
