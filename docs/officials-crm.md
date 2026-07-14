# Officials CRM (ITLK-9)

Every official the organizer deals with — alders, state legislators, the mayor, and the
federal contacts added by hand — has one page tying together how to reach them, what
they've sponsored, and everything we've said to them.

Brief §6 / user flow C. Screens: `/officials` (roster + detail, two panes) and
`/officials/review` (the tier-3 sponsor review queue from ITLK-7, re-homed under Officials).

## The routes

| Route | What it is |
| --- | --- |
| `GET /api/officials` | Roster. Additive filters: `q` (name), `role`, `ward`, `district`, `active` (`true` default / `false` / `all`). Also the letter-recipient typeahead (ITLK-10) and the review queue's "none of these" lookup. |
| `GET /api/officials/:id` | One person, whole: contact + committees + sponsored bills (with live signal) + correspondence. One round trip, because the point of the CRM is that these stop being three places. |
| `POST /api/officials` | Add a contact by hand. `source_person_ids` is null. |
| `PATCH /api/officials/:id` | Edit. Which fields are accepted depends on whether the row is sourced — see below. |

`q` matches through `normalize_name()` (migration 0004) on **both** sides, so searching
`john smith` finds `Smith, John A.` — the same definition of "the same name" the sponsor
matcher uses, rather than a second one that would drift from it.

The selected person lives in the path (`/officials/:id`), not in component state, because a
bill's sponsor list (ITLK-11) links straight at a person and a link needs somewhere to land.
The page is `[[id]].vue` — the optional-param form — so `/officials` is the same screen with
an empty right pane. The static `/officials/review` route still wins over it.

## Who owns which column

This is the rule the whole edit surface hangs off, and it is derived from the ingest code
rather than chosen: `normalizePerson` (the chi_clerk adapter) updates exactly these columns
on every poll —

    full_name, role, ward, email, phone, web_form_url, office_address, active

— and no others.

So on a **sourced** official (one with `source_person_ids`), those are ingest's. A hand-edit
to any of them survives only until the next poll, so `PATCH` **refuses it with a 409** rather
than accepting a write it knows gets reverted. The UI doesn't offer the edit, and says why.

The three columns no ingest statement names are the organizer's, on **every** official:

    relationship_notes, party, district

`relationship_notes` is the one the ticket calls out — *notes persist and survive re-ingest* —
and it survives structurally, not by luck. `party` and `district` are the organizer's for the
same reason: the eLMS person payload carries neither.

A **manual** official (`source_person_ids is null` — the federal case) has no ingest to
co-own it, so every column is editable. That null is load-bearing: `normalizePerson` finds its
subjects *by source person id*, so it can never find one of these, and can never touch it.
Both halves are pinned by regression tests in `chi_clerk/adapters.test.ts`:

- `re-ingest refreshes contact fields but never the organizer's columns`
- `an ingest poll never touches a manually-added official`

## Federal contacts — the approved variance

The brief's scope fence puts US Congress out of v1 (Epic 4), and `official_role` in the brief
stops at `alder / state_rep / state_sen / mayor`. But the organizer writes to their senator
too, and a letter to a person the CRM cannot name is a letter that cannot be logged — so
`us_rep`, `us_sen` and `other` are real roles (migration 0001 already carries them), and a
hand-added contact is a first-class Official with no source.

Federal *bill ingest* stays out of v1. This is a contact record, not a feed.

## The detail page

- **Header** — avatar, name, role · seat · party. `manual` and `inactive` render as pills;
  the brief's idiom for "not from a feed" is a dashed border, so the `manual` pill is dashed.
- **Contact** — email, phone, web form, office address, committees (via `membership`).
- **My notes** — `relationship_notes`, free text, always editable.
- **Two tabs**, in the brief's order:
  - **Sponsored bills** — via `sponsorship`, each with its **live** signal
    (WATCH/CAUTION/CLEAR/STOP) and its tracked position if it has one. The signal is
    computed from the bill's canonical status at read time, never stored — a copy of a
    signal is a copy that can go stale.
  - **Correspondence** — via `letter_official`, newest first, with the ledger's filled
    status badge. Ordered by when the exchange actually happened
    (`coalesce(sent_date, received_date, created_at)`), so a letter drafted last week but
    sent today sorts to the top.

Sponsored bills and correspondence both render empty until ITLK-10 (letters) and real
ingest give them something to show; the empty states say which.
