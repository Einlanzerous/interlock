-- 0002 — fetch_cursor (ITLK-4, Fetcher seam).
--
-- Per-source resume point for the poll loop. Lives in Postgres because it is
-- part of the seam contract: a Go ingester replacing a TS fetcher reads and
-- advances the same row. The cursor is opaque to everything except the fetcher
-- that minted it (an ISO watermark, a page token, a JSON blob — its business).
-- Advanced only in the same transaction that commits a page's source_record
-- rows + process_record jobs, so a crash never leaves it past uncommitted work.

create table fetch_cursor (
  source     bill_source primary key,
  cursor     text not null,
  updated_at timestamptz not null default now()
);

create trigger fetch_cursor_touch_updated_at
  before update on fetch_cursor
  for each row execute function touch_updated_at();
