import type { AlertChangeType } from '@interlock/shared'

/**
 * How an alert reads to a human (ITLK-8's differ decides *what* moved; this decides how to
 * say it).
 *
 * Extracted from the alerts page because ITLK-12's dashboard shows the same feed, and two
 * copies of "what does a status_change payload look like" would drift the moment the differ
 * learned a new change_type — with the drift invisible until someone compared the two
 * screens side by side.
 */

export const CHANGE_LABEL: Record<AlertChangeType, string> = {
  new_action: 'New action',
  status_change: 'Status change',
  new_sponsor: 'New sponsor',
  vote: 'Vote',
  hearing: 'Hearing',
}

export function changeLabel(type: string): string {
  return CHANGE_LABEL[type as AlertChangeType] ?? type
}

/**
 * One human line per alert, straight from the differ's payload.
 *
 * The payload shape is the differ's, per change_type. An unknown type — one a newer worker
 * writes that this UI hasn't learned yet — must still render *something*: an alert you can
 * see but not read is better than a blank row that looks like a bug, and far better than a
 * crash on the one screen whose whole job is telling you a tracked bill moved.
 */
export function summarizeAlert(changeType: string, payload: Record<string, unknown>): string {
  if (changeType === 'status_change') {
    return `${payload.from} → ${payload.to}`
  }

  if (changeType === 'new_sponsor') {
    const sponsors = (payload.sponsors ?? []) as Array<{ name?: string }>
    const names = sponsors.map((s) => s.name).filter(Boolean)
    return names.length ? names.join(', ') : 'a new sponsor signed on'
  }

  const actions = (payload.actions ?? []) as Array<{ date?: string; description?: string }>
  if (actions.length) {
    return actions.map((a) => `${a.date} — ${a.description}`).join(' · ')
  }

  // Unknown change_type, or a payload shape this UI doesn't know. Say so plainly.
  return changeLabel(changeType)
}
