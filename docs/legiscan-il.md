# The LegiScan API (Illinois GA)

What the `legiscan_il` fetcher (ITLK-6) talks to, and the things about it that will
bite you. Everything here was verified against the live API on **2026-07-13**, against
the 104th General Assembly (`session_id` 2176, 12,022 bills).

```
https://api.legiscan.com/?key=…&op=…&id=…      free tier, API key required
```

One endpoint, one verb per call. The key goes in the query string.

## The budget is the design constraint

The free tier is **~30,000 queries a month**, and the current IL session alone holds
**12,022 bills**. That single fact drives almost every decision below: a naive fetcher
that pulls each bill's detail, text, sponsors and roll calls would spend four months of
budget on its first poll and never catch up.

Query accounting is therefore durable, in the `api_budget` table (migration 0003) — an
in-process counter would reset on every worker restart and spend the cap several times
over. It warns at 80%, and the client refuses to send once the month's cap is gone.

## Ops we call, and the three we deliberately don't

| Op | Cost | Why |
| --- | --- | --- |
| `getSessionList&state=IL` | 1 / poll | Find the live session. |
| `getMasterListRaw&id={session}` | 1 / poll | **The whole change-detection surface**: `bill_id` + `change_hash` for all 12,022 bills, no paging. |
| `getBill&id={bill_id}` | 1 / *changed* bill | The full record. |

A steady-state poll costs **~3 queries**. A poll where 40 bills moved costs 42.

The brief anticipated three more ops. None of them are called, and that is not an
omission:

- **`getBillText`** — `getBill` already returns `texts[].state_link`, the document's
  URL on ilga.gov. v1 stores links; it does not parse PDFs. Calling this would fetch
  base64 document bodies we would immediately throw away.
- **`getPerson`** — `getBill` already returns each sponsor with `people_id`, `party`,
  `district`, and a full `bio` block (capitol phone, capitol address, website,
  ballotpedia). That *is* the CRM seed. A separate call per legislator would spend a
  query to re-fetch what we are already holding.
- **`getRollCall`** — the canonical schema has **no vote or roll-call table**. `getBill`
  returns vote *summaries* (`{roll_call_id, yea, nay, nv, absent, passed, chamber}`),
  which is all the model can hold; they ride along verbatim in `bill.raw` for ITLK-8's
  differ. Fetching individual member votes would be fetching data with nowhere to land.

If a later epic adds a roll-call table, `getRollCall` becomes worth its query. Until
then it is not.

## Traps

### `sine_die` does not mean "over"

The 104th GA — the **current** session, the one every live bill belongs to — is flagged:

```json
{ "session_id": 2176, "session_name": "104th General Assembly", "sine_die": 1, "prior": 0 }
```

A fetcher that filters active sessions on `sine_die == 0` ingests **nothing at all**,
silently and forever. The correct flag is **`prior == 0`**: LegiScan sets `prior: 1`
when it archives a session's dataset. That is the filter the fetcher uses.

### An error is an HTTP 200

Failure is not a status code. It is a 200 carrying:

```json
{ "status": "ERROR", "alert": { "message": "Subscription query limit exceeded" } }
```

A client that trusts the status line treats "you are out of queries" as a successful
response and parses garbage out of it. `request()` checks the envelope, not the status
line, and treats the quota alert as terminal — retrying it just burns the queries left
proving the point.

### `getMasterListRaw` is not an array

It is an object keyed by array *index*, with the session mixed in at the same level:

```json
{ "masterlist": { "session": {...}, "0": {...}, "1": {...} } }
```

Dropping the session by position rather than by name silently loses bill 0 and keeps
the session object as if it were a bill.

### `committee` is `[]` when there isn't one

A bill with no pending committee gets `"committee": []` — an empty *array* where the
object goes. An adapter that assumes an object will read `.name` off an array and write
a committee row named `undefined`.

### History rows have no id

A history row is `{date, action, chamber, importance}` and nothing else. There is no
stable identifier, but `bill_action.source_action_id` must have one — it is what the
`(bill_id, source_action_id)` unique index dedups re-polls on.

The array index will not do: **LegiScan backfills history rows**, and inserting one row
renumbers every row after it, which would duplicate the bill's entire timeline on the
next poll. The id is therefore a **content hash** of `(date, chamber, action)`, plus an
occurrence counter for the case where Illinois genuinely emits the same action text
twice on one day.

## Mapping to the canonical model

### Status: one int, two meanings

`bill.status` is an int (observed across all 12,022 bills: `1` ×9,137, `4` ×2,193,
`2` ×377, `3` ×303, `0` ×8, `5` ×4 — status `6`/Failed never appears, because Illinois
bills die by being re-referred to Rules at a deadline, not by a formal failure vote).

Two refinements are load-bearing, and both come from the `progress[]` event trail:

1. **Status 4 is two different outcomes.** An enacted Public Act and an adopted
   ceremonial resolution are *both* status 4:

   | Bill | Last action | `status` | `progress` |
   | --- | --- | --- | --- |
   | HB0022 | `Public Act . . . 104-0162` | 4 | …, **8** (Chaptered), 4 |
   | HR0001 | `Resolution Adopted` | 4 | 4 |

   Only the law carries **event 8**. Without that check, every ceremonial resolution in
   the corpus reads as enacted law.

2. **Status 1 covers a bill's whole life in committee.** 9,137 of 12,022 bills sit at
   status 1, most long since referred. **Event 9** (Refer) recovers the distinction the
   canonical model draws between `introduced` and `referred`.

### Actions: free text, so patterns not lookups

Unlike eLMS's closed vocabulary, `history[].action` is prose with names and vote counts
baked in — 500 distinct strings across a 29-bill sample:

```
Added Co-Sponsor Rep. Rita Mayfield
Do Pass as Amended / Short Debate Judiciary - Criminal Committee; 015-000-000
Public Act . . . . . . . . . 104-0162
```

`maps.ts` classifies with an **ordered rule table, and the order is the whole design**.
Amendment rules run first, because amendment actions quote the vocabulary of every other
class:

```
House Floor Amendment No. 1 Adopted                 → amendment, not passage
House Floor Amendment No. 2 Tabled                  → amendment, not withdrawal
House Committee Amendment No. 1 Referred to Rules   → amendment, not referral
```

Anchoring on `Amendment No.` ahead of everything else keeps ~25% of the distinct strings
out of the wrong bucket.

Unmatched actions fall to `other` **silently**, unlike the eLMS map, which warns. The
large uninteresting tail (`Placed on Calendar Order of 3rd Reading May 15, 2025`,
`Added Co-Sponsor Rep. X`, `Arrived in House`, `Effective Date …`) is *correctly*
`other`; the canonical model has no richer bucket for it, so there is nothing to fix and
warning on each would bury the log on every poll.

`hearing` is never produced by this source. Illinois history rows do not announce
hearings — a committee taking a bill up surfaces as its `Do Pass` outcome. Hearing
notices live on the ILGA schedule, which is not LegiScan and not in v1.

### Field map

| Canonical | LegiScan |
| --- | --- |
| `source_bill_id` | `bill_id` |
| `identifier` | `bill_number` (`HB0022`) |
| `title` / `summary` | `title` / `description` |
| `status` | `status` + `progress[]` (see above) |
| `last_action_text` / `_date` | latest `history[]` row |
| `introduced_date` | `progress[]` event 1, else earliest history date |
| `change_hash` | `change_hash` |
| `source_url` | `state_link` (ilga.gov — the authoritative page), else `url` |
| `full_text_url` | newest `texts[].state_link` |
| `session` | `session.session_name` (`104th General Assembly`) |
| `bill_type` | `bill_type` code spelled out (`B` → `bill`) |
| `bill_action[]` | `history[]`, id = content hash |
| `sponsorship[]` | `sponsors[]`, `official_id` **null** (ITLK-7 matches; ingest never guesses) |
| `sponsorship.source_person_id` | `people_id` — ITLK-7's tier-1 key |
| `official[]` | `sponsors[]` + their `bio` block |
| `committee` | `committee` (pending only; LegiScan exposes no roster) |

## Why the fetcher has no cursor

eLMS has no change primitive, so its fetcher walks a watermark. LegiScan hands us the
opposite: one query returns a `change_hash` for every bill in the session, so change
detection is a **set difference**, not a walk.

The state that difference runs against is the `change_hash` on the `source_record` rows
already staged — read through the seam's `readChangeHashes` port. A positional cursor
would be a second, weaker copy of it. So `poll()` returns `nextCursor: null`, which:

- makes a bill "done" only once its staging row is **committed** — crash mid-poll and
  the next one re-detects precisely what never landed;
- **ends the scheduler's page loop after one page**, which is what bounds a cold start
  to `LEGISCAN_MAX_BILLS_PER_POLL` (default 500) instead of letting it spend 12,022
  queries in one uninterruptible burst. A full backfill lands in ~4 days at the default
  4-hour cadence;
- makes the fetcher **self-healing**: fix an adapter bug, delete the affected staged
  rows, and the next poll re-fetches exactly those bills.

## Running the live acceptance test

It spends real queries (~27), so it is gated:

```
LEGISCAN_LIVE=1 bun test packages/worker/src/sources/legiscan_il/live.test.ts
```
