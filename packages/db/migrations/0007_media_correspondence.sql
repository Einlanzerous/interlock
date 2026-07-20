-- 0007 — media / non-official correspondence (ITLK-23).
--
-- Community engagement is not only letters to officials — it is also letters to the editor
-- and op-eds placed with outlets. The design decision (ticket + review) is to keep these in
-- the *same* ledger rather than a parallel media table, so a bill's engagement view shows
-- officials contacted and media placements together with no union. Two facts make that cheap:
--
--   1. The recipient side is already solved — an outlet is an organization contact
--      (ITLK-21, org_type = 'media'), addressed through the untouched letter_official join.
--   2. A letter already links to bills (letter_bill), so a placement about a bill shows on
--      that bill's timeline the moment it's logged.
--
-- What a media piece adds over a plain exchange is *what kind of piece it is* and *where it
-- ran*. That's this migration: a `kind`, a `url`, and a `published_date`. Channel stays what
-- it always was — how the thing was submitted (email / web_form) — because "published" is an
-- outcome, not a send-medium.

-- correspondence = the original meaning (a letter/call/email to a contact), so every existing
-- row is one by default and no backfill is needed. letter_to_editor = a submission to an
-- outlet; op_ed = a published article/op-ed.
create type letter_kind as enum ('correspondence', 'letter_to_editor', 'op_ed');

alter table letter
  add column kind           letter_kind not null default 'correspondence',
  -- Where the piece lives once public — the Block Club / Tribune link. Free-form; a
  -- submission that hasn't run yet simply has none.
  add column url            text,
  -- When it ran. Null while a letter-to-editor is still pending; set once it publishes.
  add column published_date date;

-- A publish date is a claim that something was published, so it only belongs on a media piece.
-- (url is left unconstrained — a submission can carry a link before it has a run date.)
alter table letter add constraint letter_published_date_kind
  check (published_date is null or kind <> 'correspondence');

-- "Show me our media placements" — small table, but this keeps the media-only view and a
-- bill's engagement filter from scanning every logged phone call.
create index letter_kind_media_idx on letter (kind) where kind <> 'correspondence';

comment on column letter.kind is
  'correspondence (to a contact) | letter_to_editor (submission) | op_ed (published piece).';
comment on column letter.url is 'Link to the published piece / submission (media kinds).';
comment on column letter.published_date is 'When the piece ran; null while a submission is pending.';
