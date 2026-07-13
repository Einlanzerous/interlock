/**
 * Hand-maintained eLMS → canonical vocabulary maps (ITLK-5).
 *
 * These are deliberately hand-written, not clever: the Clerk can add a status or
 * action string at any time, and when that happens ingestion must NOT break. Every
 * lookup falls back to a safe canonical value and reports the unmapped string, so
 * the bill still lands and the gap shows up in the logs as a one-line map edit.
 *
 * The vocabularies below were sampled from the live API (ITLK-5 recon, 2026-07-12)
 * over ~1,100 matters spanning the 2010–2026 corpus.
 */

import type { BillStatus, ActionClassification, SponsorType } from '@interlock/shared'

/** Reported when the source says something this map has never seen. */
export type UnmappedReporter = (kind: string, value: string) => void

const warn: UnmappedReporter = (kind, value) => {
  console.warn(`[chi_clerk] unmapped ${kind}: ${JSON.stringify(value)} — falling back`)
}

/**
 * eLMS workflow status → canonical stage.
 *
 * The vocabulary is small (`2-Submitted to Clerk`, `3-Council Introduction`,
 * `4-In Committee`, `5-Council Consideration`, `90-Final`) but `90-Final` is
 * terminal-yet-ambiguous: it says the matter is done, not how it ended. The
 * outcome lives in `subStatus`, so Final is resolved through FINAL_SUBSTATUS below.
 */
const STATUS: Record<string, BillStatus> = {
  '2-submitted to clerk': 'introduced',
  '3-council introduction': 'introduced',
  '4-in committee': 'in_committee',
  // Out of committee, awaiting the full Council vote. Chicago is unicameral, so
  // "engrossed" is the closest canonical rung on the way to passage.
  '5-council consideration': 'engrossed',
}

/** `90-Final` outcomes, from `subStatus`. */
const FINAL_SUBSTATUS: Record<string, BillStatus> = {
  passed: 'passed',
  'passed as substitute': 'passed',
  adopted: 'passed', // resolutions are adopted, not passed
  approved: 'passed',
  'failed to pass': 'failed',
  'placed on file': 'failed', // shelved without action — dead
  // The original matter was folded into a substitute ordinance (see `supersededBy`).
  'input to substitute': 'withdrawn',
}

const FINAL_STATUS = '90-final'

/**
 * Map an eLMS status (+ its subStatus) onto the canonical stage. Unknown strings
 * yield `unknown` and a warning — never an exception.
 */
export function toBillStatus(
  status: string | null | undefined,
  subStatus: string | null | undefined,
  report: UnmappedReporter = warn,
): BillStatus {
  const key = (status ?? '').trim().toLowerCase()
  if (!key) return 'unknown'

  if (key === FINAL_STATUS) {
    const sub = (subStatus ?? '').trim().toLowerCase()
    const resolved = FINAL_SUBSTATUS[sub]
    if (resolved) return resolved
    // Terminal, but the outcome is a string we've never seen. Saying "passed"
    // here would be a lie; `unknown` is honest and the warning is the fix.
    report('90-Final subStatus', subStatus ?? '')
    return 'unknown'
  }

  const mapped = STATUS[key]
  if (mapped) return mapped
  report('status', status ?? '')
  return 'unknown'
}

/** eLMS `actions[].actionName` → canonical classification. */
const ACTION: Record<string, ActionClassification> = {
  referred: 'referred',
  // A committee recommending re-referral is really a move between committees.
  'recommended for re-referral': 'referred',
  passed: 'passage',
  'passed as substitute': 'passage',
  adopted: 'passage',
  approved: 'passage',
  'failed to pass': 'failure',
  // A committee reporting a matter out is the outcome of a committee vote.
  'recommended to pass': 'vote',
  'recommended do not pass': 'vote',
  submitted: 'introduced',
  // A substitute ordinance replaces the text of the original.
  substituted: 'amendment',
  'input to substitute': 'amendment',
  'placed on file': 'withdrawn',
  withdrawn: 'withdrawn',
  'direct introduction': 'introduced',
  'council introduction': 'introduced',
  accepted: 'introduced',
  'held in committee': 'hearing',
}

export function toActionClassification(
  actionName: string | null | undefined,
  report: UnmappedReporter = warn,
): ActionClassification {
  const key = (actionName ?? '').trim().toLowerCase()
  // eLMS really does emit blank actionNames; they're still real history rows.
  if (!key) return 'other'
  const mapped = ACTION[key]
  if (mapped) return mapped
  report('actionName', actionName ?? '')
  return 'other'
}

/**
 * eLMS `sponsors[].sponsorType` → canonical sponsor type. In eLMS the lead is
 * labelled either `Sponsor` or `Filing Sponsor` (it matches the matter's
 * `filingSponsorId`); everyone else is a `CoSponsor`.
 */
const SPONSOR: Record<string, SponsorType> = {
  sponsor: 'primary',
  'filing sponsor': 'primary',
  cosponsor: 'co',
  'co-sponsor': 'co',
}

export function toSponsorType(
  sponsorType: string | null | undefined,
  report: UnmappedReporter = warn,
): SponsorType {
  const key = (sponsorType ?? '').trim().toLowerCase()
  if (!key) return 'co'
  const mapped = SPONSOR[key]
  if (mapped) return mapped
  report('sponsorType', sponsorType ?? '')
  return 'co'
}
