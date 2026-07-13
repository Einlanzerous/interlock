# The Fetcher seam

The language-agnostic ingestion boundary (ITLK-4, design brief §4). Everything
upstream of the canonical tables goes through this seam, and the seam is the
**only** thing a fetcher shares with the rest of Interlock. The v1 fetchers are
TypeScript, but the contract is deliberately just *Postgres schema + job JSON*
so any one of them can later be replaced, per-source, by a Go binary (or
anything else with a Postgres driver) with **zero downstream change**.

## The shared surfaces — the complete list

Anything not listed here is private to the TS worker and may change without
notice.

### 1. The `Fetcher` interface

```
poll(cursor) → { records[], nextCursor }
```

- `cursor` — opaque `text`, owned by the fetcher that minted it (an ISO
  watermark, a page token, a JSON blob — its business). `null` on first poll.
- `records[]` — verbatim source objects, each
  `{ sourceId, kind, payload, changeHash? }`. Pure HTTP + shaping; **no
  app-DB models, no canonical tables, no normalization.**
- `nextCursor` — resumes *after* `records`; `null` means "cursor unchanged".
  A caught-up fetcher returns `records: []` (its cursor may still advance,
  e.g. time-based watermarks). An empty page ends the poll loop.

The TS type lives in `@interlock/shared` (`packages/shared/src/seam.ts`); a Go
implementation just honors the same shape internally — the interface never
crosses a process boundary, the SQL below does.

### 2. The `source_record` staging table

```sql
insert into source_record (source, source_id, kind, payload, change_hash)
values ($1, $2, $3, $4, $5)
returning id
```

- `source` — the `bill_source` enum value the binary is polling
  (`chi_clerk` | `legiscan_il`).
- `kind` — source vocabulary (`matter` / `bill` / `person` / `body` / …).
- `payload` — the verbatim JSON. Staging is append-only: each observation is
  a new row; dedup/upsert is the Normalizer's job against canonical tables.

### 3. The `process_record` job

Enqueued by **direct SQL insert into the pg-boss job table** — not the pg-boss
API — so it can join the staging transaction:

```sql
insert into pgboss.job (name, data)
values ('process_record', '{"sourceRecordId": <source_record.id>}')
```

That JSON object is the entire job contract. The queue row itself
(`pgboss.queue`) is worker-owned: the TS worker creates it once at boot;
fetchers never create queues. (If the insert fails on a missing queue, the
worker has never booted against this database — boot it first.)

### 4. The `fetch_cursor` table

```sql
insert into fetch_cursor (source, cursor) values ($1, $2)
on conflict (source) do update set cursor = excluded.cursor
```

One row per source; read it at poll start to resume.

### 5. The single-flight advisory lock

Two-int form, class id `4540004`, object id = `hash31(source)` — djb2-xor,
31-bit (see `sourceLockKey` in `packages/worker/src/seam/scheduler.ts`; ~15
lines to port). Take `pg_try_advisory_lock(4540004, hash31(source))` before
polling; if it's not granted, another poller (any language, any process) is
already running this source — **skip, don't wait**. Migrations use a separate
single-int lock (`4540301`, see `@interlock/db`).

## The one invariant: atomic page commit

All writes for one poll page — every `source_record` insert, every
`process_record` job, and the `fetch_cursor` advance — happen in **one
transaction**:

```sql
begin;
-- for each record:
insert into source_record ... returning id;
insert into pgboss.job (name, data) values ('process_record', ...);
-- once per page:
insert into fetch_cursor ... on conflict ... do update ...;
commit;
```

This is what makes the seam crash-safe with no extra machinery:

- A crash mid-page rolls back the whole page — no orphan staging rows, no
  jobs pointing at nothing, and the cursor still points at the last page that
  fully landed.
- Restart re-polls from that cursor and re-fetches the lost page. Nothing was
  committed, so nothing duplicates. Staging is exactly-once *per committed
  page* by construction.
- Advance the cursor only in this transaction, never before, never separately.

## The Go replacement scenario, spelled out

Suppose LegiScan polling outgrows the TS worker. The swap:

1. Write a Go binary that: reads `fetch_cursor` for `legiscan_il`, takes
   `pg_try_advisory_lock(4540004, hash31("legiscan_il"))`, polls the LegiScan
   API, and commits pages with the exact transaction above. Config: a
   `DATABASE_URL` and a poll interval. No other integration.
2. Remove the `legiscan_il` entry from the TS worker's fetcher list
   (`packages/worker/src/index.ts`).
3. Deploy the binary as one more Compose service.

Nothing downstream notices: the Normalizer keeps consuming `process_record`
jobs, canonical tables keep filling, alerts keep firing. The `chi_clerk`
fetcher can stay TS forever. That reversibility is the whole point of the
seam — the language of any one ingester is a per-source, swap-anytime
decision.

## What lives where (private, may change)

| Piece | Location |
| --- | --- |
| Contract types + zod schemas | `packages/shared/src/seam.ts` |
| Atomic page commit (`commitPage`) | `packages/worker/src/seam/ingest.ts` |
| Poll loop, single-flight, backoff | `packages/worker/src/seam/scheduler.ts` |
| Pipeline consumer + `(source, kind)` → adapter dispatch | `packages/worker/src/seam/pipeline.ts` |
| `source_record` / `fetch_cursor` DDL | `packages/db/migrations/` |
| Acceptance-criteria tests | `packages/worker/src/seam/seam.test.ts` |
| `chi_clerk` fetcher + adapters (ITLK-5) | `packages/worker/src/sources/chi_clerk/` — see [chi-clerk-elms.md](./chi-clerk-elms.md) |
