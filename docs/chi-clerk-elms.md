# The Chicago City Clerk eLMS API

What the `chi_clerk` fetcher (ITLK-5) talks to, and the things about it that will
bite you. Everything here was verified against the live API on **2026-07-12/13**.

Chicago left **Legistar in June 2023**. `webapi.legistar.com/v1/chicago` still
answers, but it's a frozen 2010–2023 archive — nothing introduced after
2023-06-21. The live source is the City Clerk's eLMS:

```
https://api.chicityclerkelms.chicago.gov     public, no API key, no auth
```

## Endpoints

| Endpoint | Records | Notes |
| --- | --- | --- |
| `/matter` | ~179,000 | Legislation. List view **nulls** `actions`/`sponsors`/`attachments`. |
| `/matter/{matterId}` | — | Detail. The only place actions/sponsors/attachments are populated. |
| `/person` | 123 | Council members — the officials/CRM seed. |
| `/body` | 139 | Committees, each with a `members[]` array (same shape as `/person`). |
| `/meeting` | — | Hearings. Shape unexplored; not used in v1. |

List responses are `{ data: [...], meta: { skip, top, count, pages } }`. The detail
endpoint returns the object bare (but see the double-encoding trap below).

## Querying

**Pagination** is bare `skip` + `top` (default `top=100`). Not `$top`, not `size`,
not `limit`, not `page` — those are silently ignored, which looks like "the param
didn't work" rather than an error.

> **`skip` is capped at 100,000.** Past it the API returns HTTP 400
> (`The 'skip' parameter exceeds the maximum allowed value (100,000)`). With ~179k
> matters, **the back half of any ascending sort is simply unreachable.**

**Sorting** is one space-separated param:

```
?sort=lastPublicationDate desc      # URL-encoded: sort=lastPublicationDate%20desc
```

The field and the direction go in the *same* `sort` value. A separate
`sortDirection` (or `order`, `sortOrder`, `orderby`, …) param is **ignored**, and a
bare `sort=field` sorts **ascending**. This is the single most important fact about
the API: it's the difference between a working delta poll and quietly reading the
oldest records in the archive forever.

**There is no server-side date filter.** `lastPublicationDate=`, `fileYear=`,
`fromDate=`, `startDate=` are all ignored (`meta.count` stays at 179,137). Combined
with the skip ceiling, this rules out both "filter by date" and "sort ascending and
walk to the end" — descending + a watermark is the only delta strategy the API
actually supports.

Full-text `?search=` works and does narrow `meta.count`. Useful for spot-checks, not
for polling.

No published rate limit or SLA (it's US-gov Azure), so we self-cap at 2 req/s with
exponential backoff on 429/5xx.

## Change detection

Every record carries **`lastPublicationDate`** — the Clerk added it specifically so
data-repository refreshers can find what moved. It's the change primitive: when
anything about a matter changes, it is republished with a new
`lastPublicationDate`, which floats it back to the head of a descending sort. A
2010 ordinance amended today reappears alongside today's new ones.

So the delta poll is a **watermark walk**: sort descending, page from `skip=0`,
stop at the first record at or below the stored watermark. Deltas lead, so `skip`
stays small and never approaches the 100k ceiling.

## Traps

**The detail endpoint double-encodes its JSON.** With an `Accept: application/json`
request header, `/matter/{id}` returns a JSON *string* containing the JSON object:

```
"{\"matterId\":\"7D29E6F7-...\",\"fileYear\":2025,...}"
```

`res.json()` hands back a `string`, so every field reads as `undefined` — it fails
silently, not loudly. Drop the Accept header and the same endpoint returns a normal
object; the list endpoints are unaffected either way. `client.ts` decodes twice when
the first parse yields a string, which handles both shapes.

**`committeReferral` is misspelled** in the API (one `e`). That's the real field name.

**Empty strings, not nulls.** `actionText` and `actionByName` are frequently `""`,
and `actionName` sometimes is too — so `bill_action.description` (NOT NULL) falls
back `actionText → actionName → "(no description)"`. `recordNumber` and
`displayName` carry trailing whitespace and need trimming.

**Timestamps are UTC but encode a Chicago-local calendar day** — action dates land at
`05:00Z`, i.e. local midnight. Taking the UTC date part yields the correct local date.

**`90-Final` is terminal but says nothing about the outcome.** The result lives in
`subStatus` (`Passed`, `Failed to Pass`, `Adopted`, `Input to Substitute`, `Placed on
File`, …), so the status map resolves Final through it. `Input to Substitute` means
the matter's text was folded into a substitute ordinance — it's closed without
passing on its own, which we map to `withdrawn` (not `failed`, which would wrongly
imply it was defeated). `supersededBy` exists but is not populated.

## Vocabularies (sampled over ~1,200 matters, 2010–2026)

- `status`: `2-Submitted to Clerk`, `3-Council Introduction`, `4-In Committee`,
  `5-Council Consideration`, `90-Final`
- `subStatus` (for Final): `Passed`, `Passed as Substitute`, `Adopted`, `Approved`,
  `Failed to Pass`, `Input to Substitute`, `Placed on File`
- `actionName`: `Referred`, `Recommended to Pass`, `Recommended Do Not Pass`,
  `Recommended for Re-Referral`, `Passed`, `Failed to Pass`, `Substituted`,
  `Submitted`, and `""`
- `sponsorType`: `Sponsor` and `Filing Sponsor` (both the lead — they match the
  matter's `filingSponsorId`), `CoSponsor`
- `type`: `Ordinance`, `Resolution`, `Order`, `Claim`, `Report`, `Communication`

These maps live in `packages/worker/src/sources/chi_clerk/maps.ts`. They are
deliberately hand-maintained: an unmapped value falls back to
`unknown`/`other`/`co` **and logs a warning**, so a new Clerk vocabulary word is a
one-line map edit, never a failed ingest.
