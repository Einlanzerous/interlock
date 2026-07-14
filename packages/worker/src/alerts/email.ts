import { createTransport, type Transporter } from 'nodemailer'
import { signalForStatus, SIGNAL_LABEL, type BillStatus } from '@interlock/shared'
import type { AlertChannelPort, AlertDelivery } from './deliver'

/**
 * SMTP delivery (ITLK-8). Constructed only when SMTP_URL + ALERT_EMAIL_TO are
 * configured — with them absent the worker never instantiates this class, so
 * "in-app still works and nothing errors" is structural, not a runtime check.
 *
 * One email per processed record, all of that record's changes in one body: a
 * poll that lands an action + a status flip reads as one event to a human,
 * because it was one.
 */

export interface EmailChannelOptions {
  smtpUrl: string
  to: string
  /** Envelope sender; relays often require one. Defaults to `to`. */
  from?: string
}

export class EmailAlertChannel implements AlertChannelPort {
  readonly channel = 'email'
  private readonly transporter: Transporter
  private readonly to: string
  private readonly from: string

  constructor(options: EmailChannelOptions) {
    this.transporter = createTransport(options.smtpUrl)
    this.to = options.to
    this.from = options.from ?? options.to
  }

  async deliver(delivery: AlertDelivery): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: this.to,
      subject: subjectLine(delivery),
      text: bodyText(delivery),
    })
  }
}

/** "[Interlock] HB1234 — status change: Caution → Clear" / "— 3 updates". */
export function subjectLine({ bill, alerts }: AlertDelivery): string {
  const status = alerts.find((a) => a.changeType === 'status_change')
  if (status && alerts.length === 1) {
    const to = status.payload.to as BillStatus
    return `[Interlock] ${bill.identifier} — status: ${to} (${SIGNAL_LABEL[signalForStatus(to)]})`
  }
  if (alerts.length === 1) {
    return `[Interlock] ${bill.identifier} — ${alerts[0]!.changeType.replace('_', ' ')}`
  }
  return `[Interlock] ${bill.identifier} — ${alerts.length} updates`
}

export function bodyText({ bill, alerts }: AlertDelivery): string {
  const lines: string[] = [
    `${bill.identifier} — ${bill.title}`,
    `Your position: ${bill.position}`,
    '',
  ]
  for (const alert of alerts) {
    switch (alert.changeType) {
      case 'status_change': {
        const p = alert.payload as { from: BillStatus; to: BillStatus }
        lines.push(
          `Status: ${p.from} → ${p.to} ` +
            `(${SIGNAL_LABEL[signalForStatus(p.from)]} → ${SIGNAL_LABEL[signalForStatus(p.to)]})`,
        )
        break
      }
      case 'new_sponsor': {
        const sponsors = (alert.payload.sponsors ?? []) as Array<{ name: string }>
        lines.push(`New sponsor${sponsors.length === 1 ? '' : 's'}: ${sponsors.map((s) => s.name).join(', ')}`)
        break
      }
      default: {
        const actions = (alert.payload.actions ?? []) as Array<{ date: string; description: string; actor: string | null }>
        const heading =
          alert.changeType === 'vote' ? 'Vote' : alert.changeType === 'hearing' ? 'Hearing' : 'New action'
        for (const action of actions) {
          lines.push(`${heading}: ${action.date} — ${action.description}${action.actor ? ` (${action.actor})` : ''}`)
        }
      }
    }
  }
  return lines.join('\n')
}
