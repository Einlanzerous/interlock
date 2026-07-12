-- 0001 — canonical schema (ITLK-3, design brief §2).
--
-- Source-agnostic core: adapters map Chicago Clerk eLMS / LegiScan payloads
-- into these tables and nothing downstream ever reads a source payload directly. Idempotency
-- comes from the runner (schema_migrations tracking), so statements here are
-- plain CREATEs — each migration file runs exactly once, inside a transaction.

-- Also created by docker/initdb for compose volumes; repeated here so the
-- migrations alone stand up an empty Postgres 16 (the CI/acceptance path).
create extension if not exists pg_trgm;

-- pg-boss owns and migrates everything inside this schema (ITLK-4). Creating it
-- here keeps the seam promise — "the contract is the Postgres schema" — true
-- from the first migrate.
create schema if not exists pgboss;

-- ============================================================================
-- Enums
-- ============================================================================

-- Extensible by ALTER TYPE ... ADD VALUE (Epic 4 adds federal_congress).
-- chi_clerk = the City Clerk's eLMS (api.chicityclerkelms.chicago.gov) — Chicago
-- left Legistar in June 2023; the design brief's Legistar spec is historical.
create type bill_source as enum ('chi_clerk', 'legiscan_il');

create type jurisdiction as enum ('chicago_council', 'il_ga');

-- Canonical stage across both sources; adapters own the mapping (eLMS status
-- strings and LegiScan status ints are wider and messier than this).
-- Signal legend: watch = introduced/referred, caution = in_committee..enrolled,
-- clear = passed/enacted, stop = failed/vetoed.
create type bill_status as enum (
  'introduced',
  'referred',
  'in_committee',
  'engrossed',
  'enrolled',
  'passed',
  'enacted',
  'vetoed',
  'failed',
  'withdrawn',
  'unknown'
);

create type action_classification as enum (
  'introduced',
  'referred',
  'hearing',
  'amendment',
  'vote',
  'passage',
  'failure',
  'veto',
  'signed',
  'withdrawn',
  'other'
);

-- us_rep/us_sen/other are an approved variance from the brief: federal contacts
-- are manually added to the CRM so letters to congress people are loggable.
-- Federal *bill ingest* stays out of v1.
create type official_role as enum (
  'alder',
  'state_rep',
  'state_sen',
  'mayor',
  'us_rep',
  'us_sen',
  'other'
);

create type letter_direction as enum ('sent', 'received');
create type letter_channel as enum ('email', 'mail', 'web_form', 'phone', 'in_person');
create type letter_status as enum ('draft', 'sent', 'responded', 'closed');
create type letter_official_role as enum ('recipient', 'sender', 'cc');

create type tracked_position as enum ('support', 'oppose', 'watch');
create type alert_channel as enum ('in_app', 'email', 'both');
create type alert_change_type as enum (
  'new_action',
  'status_change',
  'new_sponsor',
  'vote',
  'hearing'
);

create type sponsor_type as enum ('primary', 'chief_co', 'co');

-- Tier 1 = stable source person id, tier 2 = pg_trgm name+ward/district,
-- tier 3 = human confirm from the review queue.
create type sponsor_match_method as enum ('source_id', 'name_similarity', 'manual');

-- ============================================================================
-- updated_at maintenance
-- ============================================================================

create function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ============================================================================
-- Canonical entities
-- ============================================================================

create table bill (
  id                   uuid primary key default gen_random_uuid(),
  source               bill_source not null,
  source_bill_id       text not null,          -- eLMS matterId GUID / LegiScan bill_id
  identifier           text not null,          -- "O2024-0001" / "HB1234"
  jurisdiction         jurisdiction not null,
  session              text,
  title                text not null,
  summary              text,
  bill_type            text,                   -- ordinance / resolution / HB ... (source vocab)
  status               bill_status not null default 'unknown',
  last_action_text     text,
  last_action_date     date,
  introduced_date      date,
  source_last_modified timestamptz,            -- eLMS lastPublicationDate watermark
  change_hash          text,                   -- LegiScan change primitive
  source_url           text,
  full_text_url        text,
  raw                  jsonb not null,         -- verbatim source payload
  search_tsv           tsvector generated always as (
                         setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                         setweight(to_tsvector('english', coalesce(summary, '')), 'B')
                       ) stored,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (source, source_bill_id)
);

create index bill_search_tsv_idx on bill using gin (search_tsv);
create index bill_jurisdiction_status_idx on bill (jurisdiction, status);

create trigger bill_touch_updated_at
  before update on bill
  for each row execute function touch_updated_at();

create table bill_action (
  id               uuid primary key default gen_random_uuid(),
  bill_id          uuid not null references bill (id) on delete cascade,
  sequence         int not null,
  action_date      date not null,
  description      text not null,              -- verbatim action text
  classification   action_classification not null default 'other',
  actor            text,                       -- body/committee that acted
  source_action_id text not null,
  raw              jsonb,
  created_at       timestamptz not null default now(),
  -- Re-polls never duplicate history rows (brief §2 dedup rules).
  unique (bill_id, source_action_id)
);

create index bill_action_timeline_idx on bill_action (bill_id, action_date desc, sequence desc);

create table official (
  id                 uuid primary key default gen_random_uuid(),
  -- {"chi_clerk": personId, "legiscan": people_id}; null = manually added
  -- contact (e.g. federal), which no ingest will ever try to match.
  source_person_ids  jsonb,
  full_name          text not null,
  role               official_role not null,
  party              text,
  ward               int,                      -- Chicago alders
  district           text,                     -- chamber-scoped, IL GA
  email              text,
  phone              text,
  web_form_url       text,
  office_address     text,
  relationship_notes text,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Tier-1 sponsor match: source_person_ids @> '{"legiscan": 1004}'.
create index official_source_person_ids_idx on official using gin (source_person_ids jsonb_path_ops);
-- Tier-2 sponsor match: pg_trgm similarity on the normalized name.
create index official_full_name_trgm_idx on official using gin (full_name gin_trgm_ops);

create trigger official_touch_updated_at
  before update on official
  for each row execute function touch_updated_at();

create table committee (
  id             uuid primary key default gen_random_uuid(),
  source         bill_source not null,
  source_body_id text not null,                -- eLMS bodyId / LegiScan committee_id
  name           text not null,
  classification text,                         -- source vocab (committee / joint committee / ...)
  jurisdiction   jurisdiction not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (source, source_body_id)
);

create trigger committee_touch_updated_at
  before update on committee
  for each row execute function touch_updated_at();

create table letter (
  id            uuid primary key default gen_random_uuid(),
  direction     letter_direction not null,
  channel       letter_channel not null,
  status        letter_status not null default 'draft',
  subject       text not null,
  body          text,                          -- draft text or notes about the exchange
  sent_date     date,
  received_date date,
  followup_date date,                          -- drives dashboard reminders
  followup_done boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The dashboard's "follow-ups due" query.
create index letter_followup_due_idx on letter (followup_date)
  where followup_date is not null and not followup_done;

create trigger letter_touch_updated_at
  before update on letter
  for each row execute function touch_updated_at();

-- ============================================================================
-- Tracking & alerting
-- ============================================================================

create table tracked_bill (
  id            uuid primary key default gen_random_uuid(),
  bill_id       uuid not null unique references bill (id) on delete cascade,
  position      tracked_position not null,
  -- Plain rank (higher = more urgent); Epic 2's campaign grouping hook.
  priority      smallint not null default 0,
  notes         text,
  alert_channel alert_channel not null default 'in_app',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger tracked_bill_touch_updated_at
  before update on tracked_bill
  for each row execute function touch_updated_at();

create table alert (
  id                 uuid primary key default gen_random_uuid(),
  bill_id            uuid not null references bill (id) on delete cascade,
  change_type        alert_change_type not null,
  detected_at        timestamptz not null default now(),
  payload            jsonb not null default '{}',  -- differ output: what moved, old → new
  read_at            timestamptz,
  delivered_channels text[] not null default '{}', -- e.g. {in_app,email} once fired
  created_at         timestamptz not null default now()
);

-- The dashboard's unread feed, newest first.
create index alert_unread_idx on alert (detected_at desc) where read_at is null;
create index alert_bill_id_idx on alert (bill_id);

-- ============================================================================
-- Joins
-- ============================================================================

create table sponsorship (
  id               uuid primary key default gen_random_uuid(),
  bill_id          uuid not null references bill (id) on delete cascade,
  -- Null = below the auto-link threshold → review queue. Never silently guess
  -- an identity (brief §2).
  official_id      uuid references official (id) on delete set null,
  -- Verbatim sponsor name from the source; what the review queue shows and
  -- what tier-2 matching runs against. (Variance from the brief's ERD, which
  -- has no column an unmatched row could be reviewed by.)
  sponsor_name     text not null,
  sponsor_type     sponsor_type not null default 'co',
  sequence         int,
  match_method     sponsor_match_method,
  match_confidence real,
  created_at       timestamptz not null default now(),
  constraint sponsorship_confidence_range
    check (match_confidence is null or (match_confidence >= 0 and match_confidence <= 1)),
  -- A matched row must say how it was matched; unmatched rows may carry the
  -- below-threshold method + confidence for the review queue to display.
  constraint sponsorship_matched_has_method
    check (official_id is null or match_method is not null)
);

-- One row per (bill, official) once matched; one pending row per verbatim
-- name while unmatched — so re-polls stay idempotent in both states.
create unique index sponsorship_matched_uniq on sponsorship (bill_id, official_id)
  where official_id is not null;
create unique index sponsorship_unmatched_uniq on sponsorship (bill_id, sponsor_name)
  where official_id is null;
create index sponsorship_official_id_idx on sponsorship (official_id);

create table letter_bill (
  letter_id uuid not null references letter (id) on delete cascade,
  bill_id   uuid not null references bill (id) on delete cascade,
  primary key (letter_id, bill_id)
);

create index letter_bill_bill_id_idx on letter_bill (bill_id);

create table letter_official (
  letter_id   uuid not null references letter (id) on delete cascade,
  official_id uuid not null references official (id) on delete cascade,
  role        letter_official_role not null default 'recipient',
  primary key (letter_id, official_id, role)
);

create index letter_official_official_id_idx on letter_official (official_id);

create table membership (
  official_id  uuid not null references official (id) on delete cascade,
  committee_id uuid not null references committee (id) on delete cascade,
  role         text,                           -- chair / vice-chair / member (source vocab)
  primary key (official_id, committee_id)
);

create index membership_committee_id_idx on membership (committee_id);

-- ============================================================================
-- Fetcher seam staging (columns per brief §4; contract detail lands in ITLK-4)
-- ============================================================================

create table source_record (
  id          bigint generated always as identity primary key,
  source      bill_source not null,
  source_id   text not null,                   -- stable id within (source, kind)
  kind        text not null,                   -- matter / bill / person / body / event / ...
  payload     jsonb not null,
  change_hash text,
  fetched_at  timestamptz not null default now()
);

create index source_record_source_kind_idx on source_record (source, kind, fetched_at desc);
