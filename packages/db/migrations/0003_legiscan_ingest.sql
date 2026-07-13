-- 0003 — LegiScan ingest support (ITLK-6).

-- ---------------------------------------------------------------------------
-- api_budget — durable query accounting for metered sources.
-- ---------------------------------------------------------------------------
-- LegiScan's free tier is ~30,000 queries/month and the 104th GA alone holds
-- 12,022 bills, so a cold-start backfill spends a real fraction of the cap. An
-- in-process counter would reset on every worker restart and spend that cap
-- several times over, so the accounting lives here.
--
-- Written through the QueryBudget port, never by a fetcher directly (the seam
-- keeps fetchers off app tables) — a Go ingester runs the same upsert.

create table api_budget (
  source     bill_source not null,
  period     text not null,              -- 'YYYY-MM', UTC: LegiScan's cap is monthly
  queries    int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (source, period)
);

create trigger api_budget_touch_updated_at
  before update on api_budget
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- sponsorship.source_person_id — the tier-1 identity key, captured at ingest.
-- ---------------------------------------------------------------------------
-- Both sources hand us a stable person id on the sponsor record itself (eLMS
-- `personId` GUID, LegiScan `people_id` int). Ingest is the only stage that holds
-- it, and ITLK-7's tier-1 match is defined as an exact match on exactly this value
-- — so it is stored on the sponsorship row rather than re-derived from `bill.raw`
-- downstream, which would put a source payload back in the matcher's hands.
--
-- Stored as text for both sources: eLMS ids are GUIDs, LegiScan's are ints, and a
-- single text column keeps the `official.source_person_ids` containment lookup one
-- shape instead of two.

alter table sponsorship add column source_person_id text;

comment on column sponsorship.source_person_id is
  'Stable person id from the source (eLMS personId / LegiScan people_id). Tier-1 match key for ITLK-7.';
