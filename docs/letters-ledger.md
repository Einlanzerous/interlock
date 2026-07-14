# Letters ledger (ITLK-10)

Every letter, call, email and web-form submission — sent or received — logged once,
cross-referenced to the bills and officials it concerns, and never falling through the
follow-up cracks.

Brief §6 / user flow B. Screen: `/letters` (full-width ledger + compose drawer).

## "Letter" means any exchange

The schema's word is `letter`, but the thing is a **correspondence log**. A phone call is a
first-class row: direction `received`, channel `phone`, the notes in the body, no send date,
and no email-shaped field required of it. The compose drawer asks for direction and channel
*first*, because everything below follows from them — pick `phone` and the "Body" field
becomes "Notes".

The only thing every row must have is a subject, because a ledger of untitled rows is
unscannable.

## The routes

| Route | What it is |
| --- | --- |
| `GET /api/letters` | The ledger. Filters: `officialId`, `billId`, `direction`, `status`. Returns each letter with its officials and bills inline, plus `followupsDue` (the dashboard's number, ITLK-12). |
| `POST /api/letters` | Log one. Letter + links land in a single transaction. |
| `PATCH /api/letters/:id` | Edit, or move it along the lifecycle. |
| `DELETE /api/letters/:id` | Remove a mistaken draft. Links cascade. |
| `GET /api/bills` | Bill search — the compose drawer's typeahead. ITLK-11 grows it into the Bills list. |

The filters are the two questions the organizer actually asks — *what have we said to this
person* and *what have we said about this bill* — and both are in the URL, so
`/letters?officialId=…` is a link. That's what the CRM's correspondence tab and (from
ITLK-11) the bill detail point at.

Both are `EXISTS` subqueries, not joins: filtering by an official must not multiply a letter
that names three of them into three rows.

## Things that bit, and are now pinned

**One official can hold two roles on one letter.** `letter_official`'s primary key is
`(letter_id, official_id, role)`, so the same person can legitimately be both `recipient` and
`cc`. That's a true fact about a letter — but any read that *joins* the table and forgets to
group will list that letter twice. The CRM's correspondence tab (ITLK-9) did exactly that
until it was caught. It now groups by letter and aggregates the roles.
Pinned by `one official can hold two roles on one letter` in `migrate.test.ts`.

**`array_agg` over an enum comes back as a string.** node-postgres registers no array parser
for a custom enum type, so `array_agg(lo.role)` returns the literal `'{recipient,cc}'` — a
string, not an array — and anything treating it as `string[]` breaks. `array_agg(lo.role::text)`
lands a real array. Same test.

**A status-only PATCH must not unlink anything.** Moving a letter along from a ledger row
sends `{status}` and nothing else; a blind delete-then-insert of the links would silently
strip every official off the letter. `PATCH` only rewrites the links the body actually names.

## Dates and the lifecycle

`draft → sent → responded → closed`, all four reachable from the ledger row (it's a `<select>`,
so going backwards works too).

Moving a letter **off** `draft` stamps today's date — `sent_date` if it's outgoing,
`received_date` if it's incoming — when it hasn't got one already. A sent letter that happened
at no time sorts nowhere, and the ledger sorts by exactly that date
(`coalesce(sent_date, received_date, created_at)`), newest first. Set the date explicitly and
it's left alone.

## Follow-ups

`followup_date` + `followup_done`. A follow-up that has come due and isn't done is the
ledger's one hazard, and it's styled like one: the row takes a `--stop` border and the date
goes red. One click marks it done.

`followupsDue` (due on or before today, not done) rides along on the ledger response, which is
the number ITLK-12's dashboard panel will read. The supporting index already exists —
`letter_followup_due_idx`, migration 0001.
