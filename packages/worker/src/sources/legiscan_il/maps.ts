/**
 * Hand-maintained LegiScan → canonical vocabulary maps (ITLK-6).
 *
 * Same discipline as the eLMS maps: every lookup falls back to a safe canonical
 * value and reports the unmapped input, so a vocabulary LegiScan adds tomorrow
 * shows up as a one-line map edit in the logs instead of a failed ingest.
 *
 * The difference from eLMS is the *shape* of the vocabulary. eLMS emits a closed
 * set of status strings, so an exact lookup works. LegiScan's `history[].action`
 * is free text with names and numbers baked into it —
 *
 *   "Added Co-Sponsor Rep. Rita Mayfield"
 *   "Do Pass as Amended / Short Debate Judiciary - Criminal Committee; 015-000-000"
 *   "Public Act . . . . . . . . . 104-0162"
 *
 * — so classification is pattern-based, in priority order. The rules below were
 * built from a 29-bill / 791-action sample of the live 104th GA (2026-07-13),
 * which held 500 distinct action strings.
 */

import type { ActionClassification, BillStatus } from '@interlock/shared'

/** Reported when the source says something these maps have never seen. */
export type UnmappedReporter = (kind: string, value: string) => void

const warn: UnmappedReporter = (kind, value) => {
  console.warn(`[legiscan_il] unmapped ${kind}: ${JSON.stringify(value)} — falling back`)
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * LegiScan `bill.status` (int) → canonical stage.
 *
 * Observed across all 12,022 bills of the 104th GA: 0 (8), 1 (9,137), 2 (377),
 * 3 (303), 4 (2,193), 5 (4). Status 6 (Failed) never appears — Illinois bills
 * die by being re-referred to Rules at a deadline, not by a formal failure vote.
 */
const STATUS: Record<number, BillStatus> = {
  1: 'introduced',
  2: 'engrossed',
  3: 'enrolled',
  4: 'passed', // refined to 'enacted' below when the bill was chaptered
  5: 'vetoed',
  6: 'failed',
}

/**
 * LegiScan `progress[].event` codes we act on. The array is the full event trail;
 * these are the two events that carry information `bill.status` does not.
 */
const PROGRESS_CHAPTERED = 8
const PROGRESS_REFERRED = 9

/**
 * Map a bill's status onto the canonical stage, refined by its progress trail.
 *
 * Two refinements, both load-bearing and both verified against live IL data:
 *
 *   1. **Status 4 is two different outcomes.** An enacted bill and an adopted
 *      resolution are both "Passed" to LegiScan. HB0022 (Public Act 104-0162)
 *      and HR0001 ("Resolution Adopted") are both status 4; only the bill carries
 *      progress event 8 (Chaptered). Without this, every ceremonial resolution
 *      would read as enacted law.
 *   2. **Status 1 covers a bill's whole life in committee.** 9,137 of 12,022 bills
 *      sit at status 1, most of them long since referred. Progress event 9 (Refer)
 *      recovers the distinction the canonical model draws between `introduced` and
 *      `referred`.
 */
export function toBillStatus(
  status: number | null | undefined,
  progress: Array<{ event?: unknown }> = [],
  report: UnmappedReporter = warn,
): BillStatus {
  // Status 0 is LegiScan's "N/A" — the bill exists but it has not staged it yet.
  if (status === 0 || status == null) return 'unknown'

  const base = STATUS[status]
  if (!base) {
    report('status', String(status))
    return 'unknown'
  }

  const events = new Set(
    progress.map((p) => (typeof p.event === 'number' ? p.event : null)).filter((e) => e !== null),
  )

  if (base === 'passed' && events.has(PROGRESS_CHAPTERED)) return 'enacted'
  if (base === 'introduced' && events.has(PROGRESS_REFERRED)) return 'referred'
  return base
}

// ---------------------------------------------------------------------------
// history[].action → action_classification
// ---------------------------------------------------------------------------

interface ActionRule {
  pattern: RegExp
  classification: ActionClassification
}

/**
 * Ordered rules — **first match wins, and the order is the whole design.**
 *
 * Amendment rules come first because amendment actions quote the vocabulary of
 * every other class and would otherwise be misread wholesale:
 *
 *   "House Floor Amendment No. 1 Adopted"                    → not a passage
 *   "House Floor Amendment No. 1 Tabled"                     → not a withdrawal
 *   "House Committee Amendment No. 1 Referred to Rules"      → not a referral
 *
 * All three name the amendment first, so anchoring on "Amendment No." ahead of
 * everything else keeps 123 of the sample's 500 distinct strings from landing in
 * the wrong bucket.
 */
const ACTION_RULES: ActionRule[] = [
  // 1. Anything about an amendment is an amendment, whatever verb follows.
  { pattern: /amendment no\.|floor amendment|committee amendment/i, classification: 'amendment' },

  // 2. Terminal outcomes — the governor's desk.
  { pattern: /public act|governor approved/i, classification: 'signed' },
  { pattern: /veto/i, classification: 'veto' },

  // 3. Passage of the bill itself.
  { pattern: /third reading.*passed|passed both houses|resolution adopted/i, classification: 'passage' },

  // 4. Recorded votes that are not final passage: committee reports, motions,
  //    concurrence. "Do Pass Executive; 012-000-000" is a committee vote.
  { pattern: /^do pass|recommends? do (pass|adopt)|prevailed|concurs?\b|motion.*(prevailed|adopted)/i, classification: 'vote' },

  // 5. Committee referral and assignment. Re-referral to Rules at a deadline is
  //    how most Illinois bills quietly die; it is still a referral.
  { pattern: /re-?referred to|referred to|assigned to|to subcommittee/i, classification: 'referred' },

  // 6. Introduction.
  { pattern: /^(pre)?filed with (the )?(clerk|secretary)|first reading/i, classification: 'introduced' },

  // 7. Withdrawal of the bill (amendment withdrawals were caught by rule 1).
  { pattern: /^withdrawn|^tabled|^motion to table/i, classification: 'withdrawn' },
]

/**
 * Classify a LegiScan history action.
 *
 * Unmatched actions are `other` **silently** — unlike the eLMS map, which warns.
 * That is deliberate: LegiScan's action text is open-ended prose, and the large
 * genuinely-uninteresting tail ("Placed on Calendar Order of 3rd Reading May 15,
 * 2025", "Added Co-Sponsor Rep. X", "Arrived in House", "Effective Date ...") is
 * *correctly* classified as `other`. Warning on each would bury the log in noise
 * on every poll and train us to ignore it. The canonical model has no richer bucket
 * for them, so there is nothing to fix and nothing to report.
 */
export function toActionClassification(action: string | null | undefined): ActionClassification {
  const text = (action ?? '').trim()
  if (!text) return 'other'
  for (const rule of ACTION_RULES) {
    if (rule.pattern.test(text)) return rule.classification
  }
  return 'other'
}

// ---------------------------------------------------------------------------
// bill_type
// ---------------------------------------------------------------------------

/**
 * `bill_type` is a code ("B", "R"), and `bill_type_id` is its int twin. The canonical
 * column holds source vocabulary, but "B" is not vocabulary anyone can read — so the
 * codes are spelled out. An unrecognized code passes through verbatim rather than being
 * dropped: an unreadable bill type is better than none.
 */
const BILL_TYPE: Record<string, string> = {
  B: 'bill',
  R: 'resolution',
  CR: 'concurrent resolution',
  JR: 'joint resolution',
  JRCA: 'joint resolution constitutional amendment',
}

export function toBillType(billType: string | null | undefined): string | null {
  const key = (billType ?? '').trim().toUpperCase()
  if (!key) return null
  return BILL_TYPE[key] ?? key
}

// ---------------------------------------------------------------------------
// sponsors[] → official
// ---------------------------------------------------------------------------

/**
 * `sponsor_type_id`: 1 = Primary/Chief, 2 = Co, 3 = Joint. LegiScan folds Illinois'
 * "Chief Co-Sponsor" into the co-sponsor bucket, so `chief_co` is unreachable from
 * this source — it exists in the canonical enum for eLMS. `sponsor_order` (1 = lead)
 * disambiguates when the id is missing.
 */
export function toSponsorType(sponsorTypeId: number | null | undefined, sponsorOrder?: number | null): 'primary' | 'co' {
  if (sponsorTypeId === 1) return 'primary'
  if (sponsorTypeId == null && sponsorOrder === 1) return 'primary'
  return 'co'
}

/**
 * `role` → canonical official_role. Illinois GA only; `role_id` 1 = Rep, 2 = Sen.
 * A sponsor whose chamber we cannot read is `other` rather than a guessed chamber.
 */
export function toOfficialRole(
  role: string | null | undefined,
  roleId: number | null | undefined,
  report: UnmappedReporter = warn,
): 'state_rep' | 'state_sen' | 'other' {
  if (roleId === 1) return 'state_rep'
  if (roleId === 2) return 'state_sen'
  const key = (role ?? '').trim().toLowerCase()
  if (key === 'rep') return 'state_rep'
  if (key === 'sen') return 'state_sen'
  if (key) report('sponsor role', role ?? '')
  return 'other'
}

/** Exposed so the map tests can assert the rule table itself, not just its outputs. */
export const __testing = { ACTION_RULES, STATUS }
