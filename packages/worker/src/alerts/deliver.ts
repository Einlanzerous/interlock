import type { Pool } from 'pg'
import type { FiredAlert, TrackedBillContext } from './differ'

/**
 * The Alerter's channel fan-out (ITLK-8).
 *
 * The in-app feed is not a channel here: the alert *row* is the in-app
 * delivery, written by the differ inside the normalize transaction and marked
 * `delivered_channels = {in_app}` at birth. What fans out post-commit is
 * everything push-shaped — today that's email; the brief's "push/webhook
 * later" plugs in as another AlertChannelPort.
 *
 * Delivery is deliberately best-effort. A channel that throws is logged and
 * skipped, never rethrown: the alert is already committed and visible in-app,
 * and failing the pg-boss job would re-run a normalize that now short-circuits
 * — the email would not be retried, the job would just burn its retries.
 */

/** Everything a channel needs to render one bill's batch of changes. */
export interface AlertDelivery {
  bill: Pick<TrackedBillContext, 'billId' | 'identifier' | 'title' | 'position'>
  alerts: FiredAlert[]
}

export interface AlertChannelPort {
  /** Recorded into alert.delivered_channels on success. */
  readonly channel: string
  deliver(delivery: AlertDelivery): Promise<void>
}

/** The pipeline's post-commit hook: (tracked bill, its fresh alerts) → fan-out. */
export type AlertSink = (ctx: TrackedBillContext, alerts: FiredAlert[]) => Promise<void>

export function makeAlerter(pool: Pool, channels: AlertChannelPort[]): AlertSink {
  return async (ctx, alerts) => {
    if (alerts.length === 0) return

    for (const channel of channels) {
      // tracked_bill.alert_channel gates email; a future channel that isn't in
      // the enum's vocabulary is on by default for whoever registers it.
      if (channel.channel === 'email' && ctx.alertChannel !== 'email' && ctx.alertChannel !== 'both') {
        continue
      }
      try {
        await channel.deliver({
          bill: {
            billId: ctx.billId,
            identifier: ctx.identifier,
            title: ctx.title,
            position: ctx.position,
          },
          alerts,
        })
        await pool.query(
          `update alert
           set delivered_channels = delivered_channels || $2::text
           where id = any($1) and not ($2 = any(delivered_channels))`,
          [alerts.map((a) => a.id), channel.channel],
        )
      } catch (err) {
        console.error(
          `[alerter] ${channel.channel} delivery failed for ${ctx.identifier} — alert is still in-app`,
          err,
        )
      }
    }
  }
}
