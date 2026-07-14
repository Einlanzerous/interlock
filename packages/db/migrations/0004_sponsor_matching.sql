-- 0004 — sponsor → official matching (ITLK-7).

-- ---------------------------------------------------------------------------
-- sponsorship.source_district — the tier-2 disambiguator, captured at ingest.
-- ---------------------------------------------------------------------------
-- Tier 2 is "normalized name + ward/district agreement", which means the matcher
-- needs the district the *source* attributed to the sponsor — not just the one the
-- Official happens to hold today. Both sources put it on the sponsor record:
-- eLMS sends `office` ("15", zero-padded), LegiScan sends `district` ("HD-059").
--
-- Kept as verbatim source text, like source_person_id: interpreting it is the
-- matcher's job, and the two sources disagree about what a district even looks like.
--
-- Ward/district lives on `official` as the person's *current* seat, so redistricting
-- does not orphan anyone (brief §2). This column is the historical claim the source
-- made about one sponsorship, which is a different fact.

alter table sponsorship add column source_district text;

comment on column sponsorship.source_district is
  'Ward/district the source attributed to this sponsor (eLMS office / LegiScan district). Tier-2 disambiguator.';

-- ---------------------------------------------------------------------------
-- normalize_name — one definition of "the same name", used on BOTH sides.
-- ---------------------------------------------------------------------------
-- Tier 2 compares a sponsor string against an Official's name, and the two sources
-- do not agree on how to write a person down:
--
--   eLMS      "Lopez, Raymond A."      (Last, First M.)
--   LegiScan  "Daniel Didech"          (First Last)
--   brief AC  "Smith, John (Ward 12)"  (Last, First + a parenthetical ward)
--
-- Comparing those raw is not a fuzzy match, it is a coin flip. So both sides are put
-- through this function first, and pg_trgm's similarity runs on the results.
--
-- It lives in SQL rather than TypeScript for two reasons: it must be usable in the
-- functional index below (otherwise every match is a sequential scan over `official`),
-- and one definition beats two that drift.

create function normalize_name(raw text) returns text
language plpgsql
immutable
strict
parallel safe
as $$
declare
  n text := lower(raw);
  comma int;
begin
  -- 1. Fold accents. Deliberately translate() and not the unaccent extension:
  --    unaccent() is STABLE (it reads a dictionary file at runtime), so Postgres
  --    refuses it in an index expression. The accent set that actually turns up on
  --    Chicago and Springfield rosters — Spanish and Polish — is small and known.
  --    (Ortíz, Jiménez, González, Zalewski.)
  n := translate(
    n,
    'áàâäãåāéèêëēíìîïīóòôöõøōúùûüūñńçćłśźżýÿ',
    'aaaaaaaeeeeeiiiiiooooooouuuuunncclszzyy'
  );

  -- 2. Drop parentheticals — the brief's own example carries one: "Smith, John (Ward 12)".
  n := regexp_replace(n, '\([^)]*\)', ' ', 'g');

  -- 3. Drop quoted nicknames: 'Elizabeth "Lisa" Hernandez'. Only double quotes —
  --    stripping single-quoted runs would eat the apostrophe out of O'Brien.
  n := regexp_replace(n, '"[^"]*"', ' ', 'g');

  -- 4. "Last, First Middle" → "First Middle Last", on the FIRST comma only.
  --    This also quietly handles "González, Jr." — the flip puts the suffix in front,
  --    and step 5 removes it either way.
  comma := position(',' in n);
  if comma > 0 then
    n := substr(n, comma + 1) || ' ' || substr(n, 1, comma - 1);
  end if;

  -- 5. Strip honorifics and generational suffixes.
  n := regexp_replace(n, '\y(rep|sen|ald|alderman|alderwoman|mayor|dr|mr|mrs|ms|hon|jr|sr|ii|iii|iv)\y', ' ', 'g');

  -- 6. Everything that is not a letter or digit becomes a space. Hyphens included, so
  --    "Meyers-Martin" and "Meyers Martin" agree; apostrophes too, so "O'Brien" and
  --    "OBrien" both become "o brien" on both sides.
  n := regexp_replace(n, '[^a-z0-9]+', ' ', 'g');

  -- 7. Drop standalone single letters — middle initials. "Raymond A. Lopez" and
  --    "Raymond Lopez" are the same person, and the stray " a " costs enough trigrams
  --    to push a true match under the threshold.
  --
  --    This deliberately collapses "John A. Smith" and "John B. Smith" onto one string.
  --    That is not a bug: two Officials colliding makes the match AMBIGUOUS, and an
  --    ambiguous match goes to the review queue instead of being guessed at.
  n := regexp_replace(n, '\y[a-z]\y', ' ', 'g');

  -- 8. Collapse.
  return btrim(regexp_replace(n, '\s+', ' ', 'g'));
end
$$;

comment on function normalize_name(text) is
  'Canonical form of a person name for tier-2 sponsor matching. Applied to BOTH the sponsor string and official.full_name.';

-- The tier-2 index. The old raw-name index (0001) could never serve a normalized
-- comparison — the whole point is that the raw forms disagree — so it is replaced
-- rather than kept alongside.
drop index official_full_name_trgm_idx;
create index official_normalized_name_trgm_idx
  on official using gin (normalize_name(full_name) gin_trgm_ops);

-- The review queue's driving query: unmatched sponsorships, newest bills first.
create index sponsorship_unmatched_review_idx on sponsorship (bill_id)
  where official_id is null;
