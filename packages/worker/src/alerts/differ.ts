import type { PoolClient } from 'pg'
import {
  signalForStatus,
  type ActionClassification,
  type AlertChangeType,
  type AlertChannel,
  type BillStatus,
  type Source,
  type SponsorType,
  type TrackedPosition,
} from '@interlock/shared'

/**
 * The Differ (ITLK-8): decides whether a processed record moved a tracked bill,
 * and if so, what kind of movement it was.
 *
 * The one rule that matters: **always diff, never trust the change primitive
 * alone.** Legistar-family watermarks bump without meaningful change, and
 * LegiScan's change_hash covers fields nobody tracks a bill for (a re-OCR'd
 * text link, say). So the differ compares canonical state — a snapshot taken
 * before the adapter ran against one taken after — and a watermark advance
 * that produced an empty diff fires nothing.
 *
 * Both snapshot and diff run **inside the record's normalize transaction**.
 * That is what makes alerts exactly-once: the alert rows commit atomically
 * with the canonical change that caused them, so a crash can't separate the
 * two, and a re-poll of the same upstream state short-circuits in the adapter,
 * produces an identical snapshot pair, and inserts nothing.
 */

/** What the differ saw of a bill at one instant. */
interface BillSnapshot {
  status: BillStatus
  /** source_action_id of every history row. */
  actionIds: Set<string>
  /** Verbatim sponsor names — stable across ITLK-7 matching, which only links them. */
  sponsorNames: Set<string>
}

/** A tracked bill mid-flight through the pipeline: identity + pre-state. */
export interface TrackedBillContext {
  billId: string
  identifier: string
  title: string
  position: TrackedPosition
  alertChannel: AlertChannel
  before: BillSnapshot
}

/** An alert row the differ just wrote, for the post-commit channel fan-out. */
export interface FiredAlert {
  id: string
  changeType: AlertChangeType
  payload: Record<string, unknown>
}

/**
 * Pre-state lookup, keyed the same way the adapters key their upsert:
 * (source, source_bill_id = the staged record's sourceId). Returns null unless
 * the record's bill exists AND is tracked — the untracked 99% pay one indexed
 * query and skip everything else. A bill first seen by this very record can't
 * be tracked yet (tracked_bill references bill.id), so it lands here as null
 * and correctly fires nothing.
 */
export async function snapshotTrackedBill(
  db: PoolClient,
  source: Source,
  sourceId: string,
): Promise<TrackedBillContext | null> {
  const { rows } = await db.query<{
    bill_id: string
    identifier: string
    title: string
    status: BillStatus
    position: TrackedPosition
    alert_channel: AlertChannel
  }>(
    `select b.id as bill_id, b.identifier, b.title, b.status, tb.position, tb.alert_channel
     from bill b
     join tracked_bill tb on tb.bill_id = b.id
     where b.source = $1 and b.source_bill_id = $2`,
    [source, sourceId],
  )
  const bill = rows[0]
  if (!bill) return null

  return {
    billId: bill.bill_id,
    identifier: bill.identifier,
    title: bill.title,
    position: bill.position,
    alertChannel: bill.alert_channel,
    before: {
      status: bill.status,
      actionIds: await actionIds(db, bill.bill_id),
      sponsorNames: await sponsorNames(db, bill.bill_id),
    },
  }
}

async function actionIds(db: PoolClient, billId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ source_action_id: string }>(
    `select source_action_id from bill_action where bill_id = $1`,
    [billId],
  )
  return new Set(rows.map((r) => r.source_action_id))
}

async function sponsorNames(db: PoolClient, billId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ sponsor_name: string }>(
    `select sponsor_name from sponsorship where bill_id = $1`,
    [billId],
  )
  return new Set(rows.map((r) => r.sponsor_name))
}

/** How a new action's classification picks its alert change_type. */
function actionChangeType(classification: ActionClassification): AlertChangeType {
  if (classification === 'vote' || classification === 'passage' || classification === 'failure') {
    return 'vote'
  }
  if (classification === 'hearing') return 'hearing'
  return 'new_action'
}

/**
 * Post-state comparison + alert writes. Call after normalize/match, same
 * transaction as the snapshot.
 *
 * Grouping: one alert row per change_type per processed record — the ticket's
 * "exactly one alert with change_type = new_action", even when a single poll
 * lands three routine actions at once. A vote or hearing among them files
 * under its own type; a status flip files alongside whatever action caused it.
 */
export async function diffTrackedBill(
  db: PoolClient,
  ctx: TrackedBillContext,
): Promise<FiredAlert[]> {
  const { rows: billRows } = await db.query<{ status: BillStatus }>(
    `select status from bill where id = $1`,
    [ctx.billId],
  )
  const after = billRows[0]
  if (!after) return [] // bill deleted mid-flight; nothing sane to report

  const payloads = new Map<AlertChangeType, Record<string, unknown>>()

  // New history rows, bucketed by what they were.
  const { rows: actionRows } = await db.query<{
    source_action_id: string
    action_date: string
    description: string
    classification: ActionClassification
    actor: string | null
  }>(
    `select source_action_id, action_date::text, description, classification, actor
     from bill_action where bill_id = $1
     order by action_date, sequence`,
    [ctx.billId],
  )
  for (const row of actionRows) {
    if (ctx.before.actionIds.has(row.source_action_id)) continue
    const changeType = actionChangeType(row.classification)
    const payload = payloads.get(changeType) ?? { actions: [] }
    ;(payload.actions as unknown[]).push({
      sourceActionId: row.source_action_id,
      date: row.action_date,
      description: row.description,
      classification: row.classification,
      actor: row.actor,
    })
    payloads.set(changeType, payload)
  }

  // Status movement, expressed in both vocabularies: the canonical enum for
  // machines, the signal legend for the UI ("what color does this turn?").
  if (after.status !== ctx.before.status) {
    payloads.set('status_change', {
      from: ctx.before.status,
      to: after.status,
      fromSignal: signalForStatus(ctx.before.status),
      toSignal: signalForStatus(after.status),
    })
  }

  // New sponsor names. Diffed on the verbatim name, not official_id — ITLK-7
  // linking an existing sponsorship to a person is not the bill moving.
  const { rows: sponsorRows } = await db.query<{ sponsor_name: string; sponsor_type: SponsorType }>(
    `select sponsor_name, sponsor_type from sponsorship where bill_id = $1 order by sequence`,
    [ctx.billId],
  )
  const addedSponsors = sponsorRows.filter((r) => !ctx.before.sponsorNames.has(r.sponsor_name))
  if (addedSponsors.length > 0) {
    payloads.set('new_sponsor', {
      sponsors: addedSponsors.map((r) => ({ name: r.sponsor_name, type: r.sponsor_type })),
    })
  }

  const fired: FiredAlert[] = []
  for (const [changeType, payload] of payloads) {
    const { rows } = await db.query<{ id: string }>(
      `insert into alert (bill_id, change_type, payload, delivered_channels)
       values ($1, $2, $3, '{in_app}')
       returning id`,
      [ctx.billId, changeType, JSON.stringify(payload)],
    )
    fired.push({ id: rows[0]!.id, changeType, payload })
  }
  return fired
}
