# Sponsor → Official matching

How a sponsor line on a bill becomes a person in the CRM (ITLK-7, design brief §2).

The governing rule is the brief's, and everything below is downstream of it:

> **Never silently guess an identity.**

Every sponsorship ends up in one of exactly three states — linked because the source told
us who it is, linked because the name and the seat both agree beyond a configured bar, or
sitting in a queue waiting for a human. There is no fourth state where we link a
sponsorship because it seemed likely.

## The three tiers

| Tier | Test | `match_method` | Confidence |
| --- | --- | --- | --- |
| 1 | The source's own person id | `source_id` | 1.0 |
| 2 | Normalized name + agreeing ward/district, ≥ threshold, **exactly one** candidate | `name_similarity` | the similarity |
| 3 | Anything else | `null` — the row is unmatched and must not claim otherwise | best score seen, or null |

### Tier 1 — not a guess at all

Both sources hand us a stable person id on the sponsor record: eLMS a `personId` GUID,
LegiScan a `people_id` int. Ingest writes it to `sponsorship.source_person_id` (0003), and
`official.source_person_ids` is a jsonb map keyed by source — so tier 1 is one indexed
containment lookup:

```sql
select id from official where source_person_ids @> jsonb_build_object('chi_clerk', 'GUID-…')
```

Both ids are stored as **text**, LegiScan's int included, so the lookup is one shape rather
than two.

### Tier 2 — fuzzy, but only when it isn't a coin flip

The two sources do not agree on how to write a person down:

```
eLMS      "Lopez, Raymond A."       Last, First M.
LegiScan  "Daniel Didech"           First Last
brief AC  "Smith, John (Ward 12)"   Last, First + a parenthetical ward
```

Comparing those raw is not fuzzy matching, it is a coin flip. So both the sponsor string
and `official.full_name` go through **`normalize_name()`** (migration 0004) first, and
pg_trgm's `similarity()` runs on the results. It lives in SQL, not TypeScript, because it
must be usable in the functional GIN index — otherwise every match is a sequential scan
over `official` — and because one definition beats two that drift.

What it does, in order: fold accents (Ortíz, Jiménez, Zalewski) → drop parentheticals
(`(Ward 12)`) → drop quoted nicknames (`Elizabeth "Lisa" Hernandez`) → flip `Last, First`
→ strip honorifics and generational suffixes → punctuation to spaces (so `Meyers-Martin`
and `O'Brien` agree with themselves) → **drop standalone single letters**.

That last step matters more than it looks. `"Raymond A. Lopez"` and `"Raymond Lopez"` are
the same person, and the stray ` a ` costs enough trigrams to push a true match *under*
0.85. It also collapses `John A. Smith` and `John B. Smith` onto one string — which is not
a bug. See below.

Then two guards, either of which sends the row to tier 3:

- **The seat must not disagree.** A name that matches an Official in a different ward is
  the wrong person, however well it scores. `sponsorship.source_district` (0004) holds what
  the *source* said — eLMS `office` (`"03"`, zero-padded), LegiScan `district` (`"HD-059"`)
  — and it is compared against the Official's current seat. A missing seat on either side
  is **"nobody said"**, not a disagreement, and is not treated as one.
- **Exactly one candidate may clear the bar.** Two plausible Smiths is not a close call to
  be broken by a tiebreak rule. It is the definition of ambiguous, and it goes to a human.

### Tier 3 — the review queue

`official_id` stays null, `match_method` stays null (an unmatched row claiming a method
would misdescribe itself), and `match_confidence` records the best score we saw — so the
reviewer can tell "nothing resembled this name" from "it came within a whisker".

Reachable at **`/officials/review`**.

Candidates are **not stored**. They are a function of the current `official` table, and
that table keeps growing as ingest runs: an Official seeded an hour after a sponsorship was
queued should show up as a candidate for it, and a cached list would hide them. Recomputing
is one indexed query per row.

## What the confirm click actually buys you

Confirming links the row **and backfills the source's person id onto the Official**. That is
the whole point:

```
Bill 1   "Smith, John" (P-SMITH)   → ambiguous, queued  → human picks John B. Smith
                                                          → official gains {"chi_clerk": "P-SMITH"}
Bill 2   "Smith, John" (P-SMITH)   → tier 1. Never reaches the queue again.
```

Without the backfill, the same click would have to be repeated on every bill that person
ever sponsors — the two Smiths are just as ambiguous by name on bill 2 as they were on
bill 1. With it, one decision resolves the person *forever*.

`source_person_ids` is **merged, never replaced**: one Official can legitimately carry both
an eLMS GUID and a LegiScan `people_id`, and clobbering one to write the other would undo a
tier-1 match the other source already relies on.

## The threshold is configuration

`MATCH_NAME_SIMILARITY_THRESHOLD` (default **0.85**). The brief flags this as a number to
expect to tune, so it is not a constant in the matcher. The worker reads it at boot; the
review-queue UI reads the same value, so the bar the screen quotes can never disagree with
the bar ingest actually applied.

- Wrong people getting linked → raise it.
- Queue filling with obvious matches → lower it.

## Where it runs

Matching happens **inside the ingest transaction**, right after normalize
(`makeNormalizer`). A sponsorship row and the decision about who it points at are one fact:
a crash between them would leave the model in a state no re-poll would revisit, because the
bill's `change_hash` is already stored and the next poll short-circuits.

It re-runs on **every** poll of a bill, including one whose payload was unchanged and
short-circuited in the adapter. That is deliberate — matching depends on the state of the
`official` table, not on the bill. A sponsor queued last week becomes tier-1 matchable the
moment ingest seeds the Official it was waiting for, and the bill it sits on may never
change again. Already-matched rows are never revisited: a match, once made, is a fact about
the world (and possibly a human's decision), not something a later poll gets to overwrite.

The scoring itself lives in `@interlock/db` (`src/matching.ts`) rather than in the worker,
because two callers need the *same* answer: the worker matches during ingest, and the web
API shows a reviewer the candidates for an unmatched row. Two implementations of "how
similar are these names" would drift, and the drift would be invisible.

## Known hard cases

- **Shared surnames.** Handled — they are the ambiguous case, and they queue rather than
  guess. This is the behaviour, not a gap.
- **Name changes** (marriage, a legal change). Tier 1 keeps working (the id doesn't
  change); tier 2 breaks, and the row queues. One confirm re-teaches it.
- **A person in both sources** — an alder who becomes a state rep. Two source ids on one
  Official, which the jsonb map holds by design.
- **A one-letter first name** would be eaten by the initial-stripping step. No such
  legislator exists in Chicago or Springfield today; if one appears, the row queues rather
  than mismatching, which is the safe direction to fail.
