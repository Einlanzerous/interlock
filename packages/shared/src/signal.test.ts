import { expect, test } from 'bun:test'
import { BILL_STATUSES, SIGNALS, signalColor, signalForStatus, SIGNAL_LABEL } from './index'

test('every signal maps to a hex color', () => {
  for (const signal of SIGNALS) {
    expect(signalColor(signal)).toMatch(/^#[0-9a-f]{6}$/i)
  }
})

test('every signal has a label', () => {
  for (const signal of SIGNALS) {
    expect(SIGNAL_LABEL[signal]).toBeTruthy()
  }
})

test('every bill status maps to a signal', () => {
  for (const status of BILL_STATUSES) {
    expect(SIGNALS).toContain(signalForStatus(status))
  }
})

test('the brief legend holds', () => {
  expect(signalForStatus('introduced')).toBe('watch')
  expect(signalForStatus('referred')).toBe('watch')
  expect(signalForStatus('in_committee')).toBe('caution')
  expect(signalForStatus('passed')).toBe('clear')
  expect(signalForStatus('enacted')).toBe('clear')
  expect(signalForStatus('failed')).toBe('stop')
  expect(signalForStatus('vetoed')).toBe('stop')
})
