# Bill tracking, change detection, and alerts (ITLK-8)

The epic's One Metric lives here: **a tracked bill cannot move without an alert
firing.** This document covers the three pieces that make it true — the track
API, the Differ, and the Alerter — and the invariants they lean on.

## Tracking

`tracked_bill` (schema 0001) is a stance, not a subscription list: one row per
bill (`bill_id UNIQUE`) carrying `position` (support / oppose / watch),
`priority`, `notes`, and `alert_channel` (in_app / email / both).

| Endpoint | Does |
| --- | --- |
| `POST /api/tracked-bills` | Track. `{ billId, position, priority?, notes?, alertChannel? }`. 409 if already tracked. |
| `GET /api/tracked-bills` | List, joined with bill state + unread alert count. |
| `PATCH /api/tracked-bills/:id` | Partial update of the four stance fields. |
| `DELETE /api/tracked-bills/:id` | Untrack. Past alerts survive — they were true when they fired. |

## The Differ

A worker pipeline stage (`packages/worker/src/alerts/differ.ts`), bracketing
normalize inside the same transaction:

```
begin
  snapshot          ← tracked bill's canonical state (status, action ids, sponsor names)
  normalize         ← adapter upserts (ITLK-5/6)
  match             ← sponsor → official (ITLK-7)
  diff + alert rows ← compare snapshot to canonical state now
commit
channel fan-out     ← post-commit, best-effort (email)
```

**Always diff, never trust the change primitive alone.** Legistar-family
watermarks (`lastPublicationDate`) bump without meaningful change, and
LegiScan's `change_hash` covers fields nobody tracks a bill for. A watermark
advance that produces an empty diff fires nothing. The change primitives are
still honored in the other direction — an *unchanged* primitive short-circuits
in the adapter, which is what makes re-processing the same upstream state
duplicate-proof.

Untracked bills skip the differ entirely (one indexed lookup decides), but
their canonical data still updates. A bill first seen by the record being
processed cannot be tracked yet, so a fresh ingest never alerts.

### Change classification

One `alert` row per change type per processed record — three routine actions
landing in one poll are one `new_action` alert, not three.

| `change_type` | Fires when | Payload |
| --- | --- | --- |
| `new_action` | New `bill_action` rows classified as anything but vote/hearing | `{ actions: [{ sourceActionId, date, description, classification, actor }] }` |
| `vote` | New action classified `vote`, `passage`, or `failure` | same shape |
| `hearing` | New action classified `hearing` | same shape |
| `status_change` | Canonical `bill.status` moved | `{ from, to, fromSignal, toSignal }` |
| `new_sponsor` | A sponsor name not previously on the bill | `{ sponsors: [{ name, type }] }` |

Sponsors diff on the **verbatim name**, so ITLK-7 linking an existing
sponsorship to an Official is not "the bill moved". `status_change` payloads
carry both vocabularies: the canonical enum for machines, the signal legend
(`signalForStatus`, brief legend: WATCH introduced/referred · CAUTION in
committee · CLEAR passed/enacted · STOP failed/vetoed) for the UI.

### Why alerts write inside the transaction

The alert and the canonical change it reports commit atomically — a crash
cannot deliver the change without its alert or vice versa. Re-polls then can't
duplicate: same upstream state → adapter short-circuit → identical snapshots →
no insert. This is also the latency story: detection *is* processing, so
detection-to-alert latency is bounded by the poll interval.

## The Alerter

The in-app feed is not a delivery channel — the alert row **is** the in-app
delivery, born with `delivered_channels = {in_app}`. Everything push-shaped
fans out post-commit through `AlertChannelPort`
(`packages/worker/src/alerts/deliver.ts`); the brief's "push/webhook later"
plugs in as another port.

Email (`nodemailer`) joins only when `SMTP_URL` + `ALERT_EMAIL_TO` are set —
absent config means the channel is never constructed, so in-app-only operation
has no failure path. Delivery is best-effort: a throwing channel is logged and
skipped, because the alert is already committed and failing the pg-boss job
would only burn retries re-running a normalize that now short-circuits.
Successful delivery appends the channel to `delivered_channels`.
`tracked_bill.alert_channel` gates email per bill; one email carries all of a
record's changes.

## The feed

| Endpoint | Does |
| --- | --- |
| `GET /api/alerts?unread=1` | Newest-first feed, joined with bill + tracking. Also returns `unreadTotal`. |
| `POST /api/alerts/:id/read` | Sets `read_at` (idempotent — keeps the first read). |
| `POST /api/alerts/read-all` | Clears the unread feed. |

`/alerts` renders it; ITLK-12's dashboard consumes the same unread query.

## Open question from brief §7

Built as: in-app always on, email opt-in per tracked bill and armed only by
SMTP config. Push/webhook remain a port implementation away, no schema change
needed (`delivered_channels` is `text[]`, deliberately not the enum).
