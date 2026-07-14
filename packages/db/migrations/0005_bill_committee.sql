-- 0005 — bill → committee (ITLK-11).
--
-- ---------------------------------------------------------------------------
-- Why this exists at all
-- ---------------------------------------------------------------------------
-- ITLK-11 asks for a committee filter on the Bills list, and the canonical model had no way
-- to answer it. `committee` rows exist (both adapters write them) and `membership` links
-- them to officials — but nothing linked a *bill* to one. The chi_clerk adapter says so out
-- loud: "There is no bill↔committee join in the canonical schema, and referral is really an
-- action", and it encodes the referral as a bill_action with the committee name as `actor`.
--
-- That works for Chicago and *cannot* work for Illinois. LegiScan history rows are
-- {date, action, chamber, importance} — the adapter stores `chamber` ('H' / 'S') as the
-- actor, because a LegiScan action does not name a committee at all. A committee filter
-- derived from `bill_action.actor` would therefore match Chicago bills and silently return
-- nothing for the entire IL General Assembly, which is worse than not having the filter:
-- it would look like the answer was "no bills", not "this filter doesn't work here".
--
-- So the link becomes a column. Both sources do carry the fact, just not in their actions:
--
--   eLMS      `committeReferral`  "Committee on Budget and Government Operations"  (name only)
--   LegiScan  `committee`         {committee_id: 235, name: "Rules"}               (id + name)
--
-- ---------------------------------------------------------------------------
-- Why two columns and not one
-- ---------------------------------------------------------------------------
-- Same shape as ITLK-7's sponsor matching, and for the same reason. `source_committee` is
-- the verbatim claim the source made, captured at ingest by the only stage allowed to read a
-- payload. `committee_id` is the resolution of that claim against the `committee` table,
-- performed by a pipeline stage that re-runs on every poll.
--
-- Splitting them is what makes ingest order stop mattering. A Chicago matter can be
-- normalized before the body that defines its committee has ever been fetched; resolving the
-- name at ingest would leave that bill's committee_id null forever, because the bill's
-- watermark short-circuits the next poll and the adapter never revisits it. Resolving in a
-- re-runnable stage means the link appears the moment the committee does — exactly the
-- argument makeNormalizer already makes for running the sponsor matcher on unchanged bills:
-- the link depends on the state of the *other* table, not on the bill.

alter table bill add column source_committee text;
alter table bill add column committee_id uuid references committee (id) on delete set null;

comment on column bill.source_committee is
  'Committee the source says has this bill, verbatim (eLMS committeReferral / LegiScan committee.name). The claim; committee_id is the resolution.';

comment on column bill.committee_id is
  'The committee that has this bill: Chicago = the body it was referred to, IL = the pending committee. Resolved from source_committee by the linkCommittee pipeline stage, re-run every poll.';

-- The Bills list filter (ITLK-11): "show me everything sitting in Budget & Government Ops."
create index bill_committee_id_idx on bill (committee_id) where committee_id is not null;

-- The resolution lookup: (jurisdiction, name) → committee. A committee's *name* is the only
-- thing eLMS gives us to match on — its referral field carries no body id — so the lookup is
-- by name within a jurisdiction, and it needs to not be a sequential scan on every bill.
create index committee_jurisdiction_name_idx on committee (jurisdiction, lower(name));
