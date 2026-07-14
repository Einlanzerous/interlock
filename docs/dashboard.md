# Dashboard (ITLK-12)

The organizer's morning glance: everything that moved, and everything due. Brief §6. It is the
home route (`/`), and it opens with the alerts — because the brief's one metric is *"zero
missed movements on tracked bills"*, and this is the screen where that promise is kept or
broken.

## Three panels, one question

**What needs me today?**

| Panel | What it reads |
| --- | --- |
| **Unread alerts** | `alert` where `read_at is null`, newest first, signal-colored from the bill's canonical status. Click a row → opens the bill *and* marks it read. |
| **Follow-ups due** | `letter` where `followup_date <= current_date` and not done. Click → opens that letter in the ledger's read view. Overdue is styled as the hazard it is. |
| **Tracked bills** | `tracked_bill` counted by position. Each tile links to `/bills?position=…`. |

## One fetch, not three

`GET /api/dashboard` returns all of it in a single round trip. The three panels answer one
question at one instant; three separate requests would let them disagree about when *today*
is — a follow-up counted as due in one query and not-due in the next, across a midnight
boundary or a slow request.

`current_date` is the **database's** day, which is the same day the ledger's own overdue
styling uses. A follow-up cannot be "due" here and "not due yet" there.

## Things that are deliberate

**Opening an alert marks it read, and it is awaited before navigating.** That's the contract of
an unread feed: you cannot have looked at a thing and still be told to look at it. Firing the
POST and navigating without waiting races the route change — lose that race and the alert
comes back tomorrow having already been seen, which is exactly the failure the feed exists to
prevent.

**The all-clear is explicit.** A tracked bill that hasn't moved is the *good* outcome, and the
screen says so — naming how many bills are being watched. A blank panel reads as a broken one,
and "is this working?" is the last question this screen should provoke.

**Every stance tile renders, including the zeroes.** "Nothing opposed" is a real answer. A tile
that vanishes when its count hits zero is a tile you can't trust to still be there tomorrow,
and its absence looks identical to a bug.

**An arrived-at filter is visible and clearable.** Landing on `/bills?position=oppose` from a
tile shows an active-filter chip. Without it, a pre-filtered list just looks like a corpus with
four bills in it.

## What this ticket had to add elsewhere

Two of the three acceptance criteria needed deep-link targets that didn't exist:

- **`/api/bills?position=`** — the bills list had `tracked=1` but no way to ask for a *stance*.
  A position implies tracked (an untracked bill has no stance to hold), so it sets both.
- **`/letters?letterId=`** — the ledger had a read drawer but no way to address one letter by
  URL. "Chase this one" is useless if it only gets you to a list you then have to search.
  Opened on mount rather than watched: the drawer is a transient layer, and re-opening it every
  time the URL still carried the param would fight the user closing it.

## Shared, so the two feeds can't drift

`utils/alerts.ts` holds `changeLabel` and `summarizeAlert` — how a differ payload reads as one
human line. The dashboard and `/alerts` both use it. Two copies of "what does a `status_change`
payload look like" would drift the moment the differ learned a new `change_type`, and the drift
would be invisible until someone compared the two screens side by side.

`summarizeAlert` also renders *something* for a change type it doesn't recognize — a newer
worker writing an alert this UI hasn't learned yet must not produce a blank row, and certainly
must not crash the one screen whose whole job is telling you a tracked bill moved.
