import { expect, test } from 'bun:test'
import type { AlertDelivery } from './deliver'
import { bodyText, subjectLine } from './email'

/** Rendering only — SMTP transport is nodemailer's problem, not ours. */

const bill = { billId: 'b-1', identifier: 'HB1234', title: 'An Act concerning alerts', position: 'oppose' as const }

const statusAlert = {
  id: 'a-1',
  changeType: 'status_change' as const,
  payload: { from: 'in_committee', to: 'passed', fromSignal: 'caution', toSignal: 'clear' },
}

const actionAlert = {
  id: 'a-2',
  changeType: 'new_action' as const,
  payload: {
    actions: [
      { sourceActionId: 'x', date: '2026-07-10', description: 'Third Reading', classification: 'other', actor: 'House' },
    ],
  },
}

test('single status change → status subject with signal label', () => {
  const delivery: AlertDelivery = { bill, alerts: [statusAlert] }
  expect(subjectLine(delivery)).toBe('[Interlock] HB1234 — status: passed (Clear)')
})

test('multiple changes → count subject, all changes in body', () => {
  const delivery: AlertDelivery = { bill, alerts: [statusAlert, actionAlert] }
  expect(subjectLine(delivery)).toBe('[Interlock] HB1234 — 2 updates')
  const body = bodyText(delivery)
  expect(body).toContain('HB1234 — An Act concerning alerts')
  expect(body).toContain('Your position: oppose')
  expect(body).toContain('Status: in_committee → passed (Caution → Clear)')
  expect(body).toContain('New action: 2026-07-10 — Third Reading (House)')
})

test('new sponsor body line', () => {
  const delivery: AlertDelivery = {
    bill,
    alerts: [
      {
        id: 'a-3',
        changeType: 'new_sponsor' as const,
        payload: { sponsors: [{ name: 'Vasquez, Andre', type: 'co' }] },
      },
    ],
  }
  expect(subjectLine(delivery)).toBe('[Interlock] HB1234 — new sponsor')
  expect(bodyText(delivery)).toContain('New sponsor: Vasquez, Andre')
})
