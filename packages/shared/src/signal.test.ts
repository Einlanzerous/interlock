import { expect, test } from 'bun:test'
import { SIGNALS, signalColor, SIGNAL_LABEL } from './index'

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
