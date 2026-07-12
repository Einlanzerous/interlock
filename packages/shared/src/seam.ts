import { z } from 'zod'

/**
 * The Fetcher seam — the language-agnostic ingestion boundary (ITLK-4).
 * Everything in this file is part of the shared contract documented in
 * docs/fetcher-seam.md; a Go ingester replacing a TS fetcher honors these
 * shapes against Postgres directly. Change them only with a migration-grade
 * level of care.
 */

/** Ingest sources. Mirrors the Postgres enum `bill_source` (0001). */
export const SOURCES = ['chi_clerk', 'legiscan_il'] as const
export const sourceSchema = z.enum(SOURCES)
export type Source = z.infer<typeof sourceSchema>

/** The pg-boss queue every staged record is announced on. */
export const PROCESS_RECORD_QUEUE = 'process_record'

/** Job JSON for `process_record` — the queue half of the contract. */
export const processRecordJobSchema = z.object({
  /** `source_record.id` of the staged row to process. */
  sourceRecordId: z.number().int().positive(),
})
export type ProcessRecordJob = z.infer<typeof processRecordJobSchema>

/** One observed source object, verbatim — a `source_record` row to be. */
export const sourceRecordInputSchema = z.object({
  /** Stable id within (source, kind), e.g. eLMS matterId / LegiScan bill_id. */
  sourceId: z.string().min(1),
  /** matter / bill / person / body / event / ... — source vocabulary. */
  kind: z.string().min(1),
  /** Verbatim payload; adapters normalize it downstream, never fetchers. */
  payload: z.record(z.unknown()),
  /** Source change primitive when it has one (LegiScan change_hash). */
  changeHash: z.string().nullish(),
})
export type SourceRecordInput = z.infer<typeof sourceRecordInputSchema>

/**
 * One poll step. `nextCursor` is whatever resumes the fetch AFTER `records`
 * — an ISO watermark, a page token, a JSON blob; opaque to everything but
 * the fetcher that minted it. `null` means "cursor unchanged". A caught-up
 * fetcher returns `records: []` (its cursor may still advance, e.g.
 * time-based watermarks); that empty page ends the poll loop.
 */
export interface FetchPage {
  records: SourceRecordInput[]
  nextCursor: string | null
}

/**
 * The seam interface itself. Implementations are pure HTTP + shaping into
 * SourceRecordInput — no app-DB models, no canonical tables. The scheduler
 * owns persistence (staging writes, job enqueue, cursor commit).
 */
export interface Fetcher {
  readonly source: Source
  poll(cursor: string | null): Promise<FetchPage>
}
