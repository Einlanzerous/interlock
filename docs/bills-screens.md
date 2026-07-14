# Bills screens (ITLK-11)

Find any bill across both governments in one search box, understand where it stands at a
glance, and start tracking it in two clicks.

Brief §6 / user flow A. Screen: `/bills` (two panes — search + list left, the bill right).

## Search

Postgres FTS over `search_tsv` (title weighted A, summary B — migration 0001), so a word from
a bill's title finds it whichever source it came from. `websearch_to_tsquery`, not
`plainto_tsquery`: it takes what a person actually types — quoted phrases, `-parking` to
exclude — and doesn't throw on stray punctuation.

**Identifiers are matched literally, alongside the text search.** `HB1234` is not English and
will never appear in a tsvector built by the `english` dictionary, but it's the thing an
organizer types most. Without the `ilike` arm, searching a bill number would be the one query
that mysteriously returns nothing.

The same endpoint is the compose drawer's typeahead (ITLK-10). A typeahead that matched
differently from the Bills list would be a second, quietly disagreeing definition of "found".

## The committee filter, and the schema it needed

ITLK-11's ticket asks for a committee facet. **The canonical model had no way to answer it** —
`committee` rows existed and `membership` linked them to *officials*, but nothing linked a
*bill* to one. The chi_clerk adapter says so out loud: *"There is no bill↔committee join in
the canonical schema, and referral is really an action"*, and it encodes the referral as a
`bill_action` whose `actor` is the committee name.

That works for Chicago and **cannot** work for Illinois. A LegiScan history row is
`{date, action, chamber, importance}` — the adapter stores `chamber` (`'H'` / `'S'`) as the
actor, because a LegiScan action never names a committee. A filter derived from
`bill_action.actor` would match Chicago bills and silently return **nothing** for the entire
IL General Assembly. That's worse than having no filter: it reads as *"there are no bills in
Rules"* rather than *"this filter doesn't work here"*.

So migration 0005 adds the link, in the shape ITLK-7 already established for sponsors:

| Column | What it is |
| --- | --- |
| `bill.source_committee` | The **claim**. What the source said, verbatim, captured at ingest by the only stage allowed to read a payload. eLMS `committeReferral` (a bare name — no body id), LegiScan `committee.name`. |
| `bill.committee_id` | The **resolution**. That claim matched against the `committee` table by the `linkCommittee` pipeline stage. |

**Why the split is load-bearing:** it is what makes ingest order stop mattering. eLMS serves
matters and bodies from different endpoints with no ordering guarantee, so a Chicago matter is
routinely normalized *before* the body defining its committee has ever been fetched. Resolve
the name inside the adapter and that bill's `committee_id` is null **forever** — its
`source_last_modified` watermark short-circuits the next poll and the adapter never looks at
it again. Resolve it in a re-runnable stage and the link appears on the first poll after the
committee does.

This is the identical argument `makeNormalizer` already makes for running the sponsor matcher
on unchanged bills: *the answer depends on the state of the other table, not on the bill.*

Matching is by **name within a jurisdiction**, case-insensitive, and nothing fuzzier. A
committee is not a person — no nicknames, no married names, no middle initials — and two
committees with names close enough to confuse a trigram are two different committees. Chicago
and Springfield both have a "Rules"; linking across them would be a silent, plausible, wrong
answer. If the name matches nothing, `committee_id` stays null. Same discipline as never
silently guessing an identity.

`GET /api/committees` lists only committees that actually **have** a bill, with counts. A
dropdown full of entries that match nothing invites the conclusion "there are no bills in
Zoning" when the truth is that nothing was ever linked to it.

## The detail pane

Everything about one bill, in the order flow A wants it:

- **Header** — signal dot + identifier + the signal's name, the title, then source /
  status / type / session / committee as pills. The committee pill is a link back into the
  filtered list.
- **Source link** — `source_url` (the authoritative record: ILGA over legiscan.com) and
  `full_text_url` when there is one.
- **Sponsors** — linked to their CRM page where the matcher resolved them (ITLK-7). An
  **unmatched** sponsor renders as plain text with a dashed `unmatched` chip pointing at the
  review queue. It is still shown: the source said they put their name on this, and hiding it
  would misreport the bill.
- **Action timeline** — newest first, on the brief's spine (accent at the newest end, fading
  to `--line`). The newest node is lit; the rest are `--faint`.
- **Letters** — everything logged about this bill (ITLK-10), linking through to the ledger.
- **Track** — anchored to the bottom of the pane, because flow A ends there and it is the one
  control on this screen that *changes* something.

## Track

`tracked_bill.bill_id` is UNIQUE, so the button is a toggle-and-edit, never a
duplicate-create. Pick a position (`support` / `oppose` / `watch`) and a priority; the row
appears in the list with its stance, and the worker's differ (ITLK-8) starts watching it —
after which it cannot move without an alert firing.
