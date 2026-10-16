import { expect, test } from 'bun:test'
import { toActionClassification, toBillStatus } from './maps'

/**
 * These three eLMS values were surfaced by the ITLK-15 live acceptance pull (the current
 * month's matters), which the 2010–2026 recon sample had missed. The map now covers them;
 * these tests keep them covered and assert they no longer fall back with a warning.
 */

/** A reporter that records any unmapped callback, so "did not warn" is testable. */
function spy() {
  const seen: Array<[string, string]> = []
  return { report: (kind: string, value: string) => seen.push([kind, value]), seen }
}

test('Mayoral signing classifies as `signed`, not a warned fallback', () => {
  const a = spy()
  expect(toActionClassification('Signed by Mayor', a.report)).toBe('signed')
  expect(toActionClassification('Signed', a.report)).toBe('signed')
  expect(a.seen).toEqual([])
})

test('a bare `Introduced` action maps to `introduced`', () => {
  const a = spy()
  expect(toActionClassification('Introduced', a.report)).toBe('introduced')
  expect(a.seen).toEqual([])
})

test('a Final matter signed into law is `enacted`', () => {
  const a = spy()
  expect(toBillStatus('90-Final', 'Signed', a.report)).toBe('enacted')
  expect(a.seen).toEqual([])
})

test('a genuinely unknown value still warns and falls back', () => {
  const a = spy()
  expect(toActionClassification('Teleported', a.report)).toBe('other')
  expect(a.seen).toEqual([['actionName', 'Teleported']])
})

/**
 * ITLK-33: strings the v1.4.0 worker logged as unmapped in prod. Before this, 199
 * finished Council matters sat at `unknown` — including three mayoral vetoes.
 */
test.each([
  ['Vetoed', 'vetoed'],
  ['Approved as Substitute', 'passed'],
  ['Adopted as Substitute', 'passed'],
  ['Published in Special Pamphlet', 'passed'],
  ['Tabled', 'failed'],
] as const)('a Final matter with subStatus %p is `%s`, without a warning', (sub, want) => {
  const a = spy()
  expect(toBillStatus('90-Final', sub, a.report)).toBe(want)
  expect(a.seen).toEqual([])
})

test.each([
  ['Vetoed', 'veto'],
  ['Tabled', 'failure'],
  ['Amended', 'amendment'],
  ['Substituted-Aggregated', 'amendment'],
  ['Deferred and Published', 'other'],
  ['Immediate Consideration', 'other'],
  ['Published in Special Pamphlet', 'other'],
  ['Committee Discharged', 'other'],
] as const)('action %p classifies as `%s`, without a warning', (name, want) => {
  const a = spy()
  expect(toActionClassification(name, a.report)).toBe(want)
  expect(a.seen).toEqual([])
})

test('an unseen Final subStatus is still `unknown` and still warns', () => {
  const a = spy()
  expect(toBillStatus('90-Final', 'Teleported', a.report)).toBe('unknown')
  expect(a.seen).toEqual([['90-Final subStatus', 'Teleported']])
})
