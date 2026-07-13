# Open States v3 — the Illinois fallback

**Status: documented, not built.** ITLK-6 ships LegiScan as the Illinois source. This
is the escape hatch if LegiScan's IL coverage lags, its free tier changes, or we want an
independent cross-check of what we ingested.

> **Verification note.** Everything in the LegiScan doc was checked against the live API.
> This one was **not**: the `OPENSTATES_API_KEY` slot in `.env` is empty — the organizer
> holds a LegiScan key but no Open States key. What follows is from the published v3 API
> spec, so treat the shapes as *design input*, not as verified fact. Getting a key (free,
> self-serve at openstates.org/accounts/profile/) and doing a recon pass is the first step
> of any actual cutover.

```
https://v3.openstates.org        X-API-KEY header (or ?apikey=)
```

## Why it is a credible fallback

It lands in the **same canonical model**. The seam (ITLK-4) means a second Illinois source
is a new `Fetcher` + a new adapter and nothing else: no schema change downstream, no
change to the pipeline, no change to the UI. `bill_source` gains a value
(`alter type bill_source add value 'openstates_il'`), and `official.source_person_ids`
gains a key — it is a jsonb map precisely so a person can carry ids from more than one
source.

## Shape

| Endpoint | Use |
| --- | --- |
| `GET /bills?jurisdiction=Illinois` | The list. `include=sponsorships&include=actions&include=sources` folds detail into the list response. |
| `GET /bills/{openstates_id}` | One bill, by `ocd-bill/…` id. |
| `GET /people?jurisdiction=Illinois` | The CRM seed (`ocd-person/…` ids). |
| `GET /committees?jurisdiction=Illinois` | Rosters — which LegiScan does **not** expose. |

Paged with `page` + `per_page` (max 20), responding
`{results: [...], pagination: {page, per_page, max_page, total_items}}`.

## The one thing that makes it worse than LegiScan

**There is no `change_hash`.** LegiScan hands over a content hash for all 12,022 bills in
a single query, so change detection is an exact set difference and an unchanged bill costs
nothing (see [legiscan-il.md](./legiscan-il.md)). Open States has no equivalent; the delta
primitive is `updated_since={iso8601}` against the bill's `updated_at`.

That is a **watermark**, not a hash, and it is strictly weaker:

- `updated_at` moves when *Open States* re-scrapes, not necessarily when *Illinois* acts.
  A cosmetic upstream change re-delivers the bill, and the adapter cannot cheaply tell
  that nothing moved — it has to diff the payload it just paid for.
- It cannot answer "what did I miss while I was down" as precisely; you re-walk from the
  watermark and re-ingest the overlap.

So an Open States fetcher would look like the **eLMS** fetcher (a watermark walk, see
`sources/chi_clerk/fetcher.ts`), not like the LegiScan one. The good news is that shape is
already built and proven once.

Its idempotency would lean entirely on the adapter's `is distinct from` row comparisons
rather than on a source-provided hash — which the eLMS adapter already demonstrates is
sufficient to keep re-polls at zero writes.

## Rate limits

The free tier is metered **per day** (published as roughly 10 req/min, 250 req/day),
where LegiScan meters ~30,000 per *month*. For steady-state polling either is ample. For a
cold-start backfill of a ~12,000-bill session at `per_page=20`, ~600 requests is several
days against a 250/day cap — so a cutover wants the same
`*_MAX_BILLS_PER_POLL`-style bound the LegiScan fetcher already uses, and the same durable
`api_budget` accounting (the table is keyed by `(source, period)` and takes another source
without a migration).

## What it would cost to build

Roughly a day, most of it in the adapter's vocabulary map:

1. `alter type bill_source add value 'openstates_il'` + a jurisdiction entry.
2. `sources/openstates_il/{client,fetcher,adapters,maps}.ts` — the fetcher is a watermark
   walk on `updated_since`, so it is the eLMS fetcher with different field names.
3. Vocabulary map. Open States classifications are already *normalized* (`passage`,
   `referral-committee`, `amendment-passage`, …) rather than free prose, so this map is
   **easier** than LegiScan's — closer to a lookup than to a rule table.
4. Tier-1 identity: `sponsorships[].person.id` (`ocd-person/…`) → a new key in
   `official.source_person_ids`. ITLK-7's matcher needs no change; it reads
   `sponsorship.source_person_id`, which is source-agnostic text by design.

## When to actually reach for it

- LegiScan's IL data goes stale or its free tier is withdrawn.
- We want committee **rosters** for IL (LegiScan exposes only a bill's pending committee;
  Open States has `/committees` with membership).
- Cross-checking a bill we suspect we ingested wrong — Open States is an independent
  scrape, so agreement between the two is real evidence.

Running both at once is supported by the model (two sources, two `bill` rows, one
`official` carrying both person ids) but it doubles ingest cost for little gain, and
nothing in v1 de-duplicates a bill across sources. Treat it as a cutover, not a merge.
