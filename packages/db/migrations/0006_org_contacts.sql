-- 0006 — organizations as first-class contacts (ITLK-21).
--
-- The CRM's `official` table is already "everyone the organizer deals with" — it holds
-- hand-added federal contacts (us_sen/other) alongside sourced alders. An organization
-- (CMAP, CDOT, a community group) is the same kind of thing: a correspondence target a
-- letter can be addressed to. So orgs live here too, behind a `contact_type` discriminator,
-- rather than in a parallel table that would force `letter_official` — the whole ledger
-- join — to become polymorphic.
--
-- Why a flag and not a new entity (the ticket's design question): letters already link to
-- arbitrary officials by id, so the ledger side is free the moment an org *is* an official.
-- And orgs are always manual (no source), so `source_person_ids` stays null on every one —
-- which means ingest and the sponsor matcher, both of which only ever find rows by
-- source person id, are structurally incapable of touching an org. Zero downstream change,
-- which is the seam promise.

-- 'person' is the default so every existing row — all people — is one without a backfill.
create type contact_type as enum ('person', 'org');

-- The org's kind, the way `role` is a person's elected/appointed seat. Kept as its own
-- column rather than folded into `official_role` so the person role picker never has to
-- offer "media" and the org picker never has to offer "alder". `other` is the escape hatch,
-- same as it is for people.
create type org_type as enum ('agency', 'media', 'advocacy', 'community_group', 'other');

alter table official
  add column contact_type contact_type not null default 'person',
  add column org_type     org_type,
  -- Free-text sub-unit ("Planning Division", "City Desk") — an org's analogue to a seat.
  add column department    text,
  -- A person's affiliation: a named staffer *at* an org points here. Self-referential and
  -- nullable; on an org it is always null (v1 keeps the org graph one level deep). Letters
  -- still attribute honestly — the letter names the person as recipient, and their org is
  -- one hop away. `on delete set null` so deleting the org orphans the staffer, not deletes.
  add column org_id        uuid references official (id) on delete set null;

-- `role` was NOT NULL because every contact was a person. An org has no elected role, so
-- the column must be droppable — the check below re-imposes it for people specifically.
alter table official alter column role drop not null;

-- The shape rule, in one place: a person is role-shaped, an org is org_type-shaped, and
-- neither wears the other's discriminator. org_id (an affiliation) only makes sense on a
-- person, so an org may not carry one.
alter table official add constraint official_contact_shape check (
  (contact_type = 'person' and role is not null and org_type is null)
  or
  (contact_type = 'org' and role is null and org_type is not null and org_id is null)
);

-- An org must not point its own affiliation at itself.
alter table official add constraint official_org_id_not_self check (org_id is null or org_id <> id);

-- "Everyone on staff at this org" — the org detail page's people list.
create index official_org_id_idx on official (org_id) where org_id is not null;
-- Roster/typeahead filter by contact_type; low cardinality but the roster is small and this
-- keeps "just the orgs" / "just the people" a scan-free filter.
create index official_contact_type_idx on official (contact_type);

comment on column official.contact_type is
  'person | org. Orgs (CMAP, CDOT, community groups) are correspondence targets, always manual.';
comment on column official.org_type is
  'The org''s kind (agency/media/advocacy/community_group/other). Non-null iff contact_type = org.';
comment on column official.org_id is
  'A person''s affiliated organization (self-ref). Null on orgs.';
