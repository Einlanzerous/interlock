import { describe, expect, test } from 'bun:test'
import { toActionClassification, toBillStatus, toBillType, toOfficialRole, toSponsorType } from './maps'

/**
 * ITLK-6 vocabulary maps — pure functions, no network, no DB.
 *
 * Every string in here is verbatim from the live 104th GA (2026-07-13 recon), so these
 * assertions are claims about Illinois, not about our imagination.
 */

const chaptered = [{ event: 1 }, { event: 9 }, { event: 3 }, { event: 8 }, { event: 4 }]
const referred = [{ event: 1 }, { event: 9 }]

describe('toBillStatus', () => {
  test('separates an enacted Public Act from an adopted resolution — both are status 4', () => {
    // HB0022 → "Public Act . . . . . . . . . 104-0162", progress carries event 8.
    expect(toBillStatus(4, chaptered)).toBe('enacted')
    // HR0001 → "Resolution Adopted", progress is just [{event: 4}]. Same status int.
    expect(toBillStatus(4, [{ event: 4 }])).toBe('passed')
  })

  test('recovers `referred` from the progress trail — 9,137 of 12,022 IL bills sit at status 1', () => {
    expect(toBillStatus(1, referred)).toBe('referred')
    expect(toBillStatus(1, [{ event: 1 }])).toBe('introduced')
  })

  test('maps the remaining observed statuses straight through', () => {
    expect(toBillStatus(2, [])).toBe('engrossed')
    expect(toBillStatus(3, [])).toBe('enrolled')
    expect(toBillStatus(5, [])).toBe('vetoed')
    expect(toBillStatus(6, [])).toBe('failed')
  })

  test('status 0 (LegiScan "N/A") and a status we have never seen are `unknown`, not a guess', () => {
    expect(toBillStatus(0, [])).toBe('unknown')
    expect(toBillStatus(null, [])).toBe('unknown')

    const unmapped: string[] = []
    expect(toBillStatus(99, [], (_kind, value) => unmapped.push(value))).toBe('unknown')
    expect(unmapped).toEqual(['99'])
  })
})

describe('toActionClassification', () => {
  test('an amendment action is an amendment, whatever verb it quotes', () => {
    // The whole reason the rule table is ordered. Each of these would otherwise land
    // in a different (wrong) bucket on the strength of its second clause.
    expect(toActionClassification('House Floor Amendment No. 1 Adopted')).toBe('amendment')
    expect(toActionClassification('House Floor Amendment No. 2 Tabled')).toBe('amendment')
    expect(toActionClassification('House Committee Amendment No. 1 Referred to Rules Committee')).toBe('amendment')
    expect(
      toActionClassification('House Floor Amendment No. 1 Withdrawn by Rep. Emanuel "Chris" Welch'),
    ).toBe('amendment')
    expect(
      toActionClassification('Senate Floor Amendment No. 1 Filed with Secretary by Sen. Julie A. Morrison'),
    ).toBe('amendment')
  })

  test('final passage of the bill itself', () => {
    expect(toActionClassification('Third Reading - Short Debate - Passed 073-034-000')).toBe('passage')
    expect(toActionClassification('Third Reading - Passed; 043-011-000')).toBe('passage')
    expect(toActionClassification('Passed Both Houses')).toBe('passage')
    expect(toActionClassification('Resolution Adopted')).toBe('passage')
  })

  test('the governor’s desk', () => {
    expect(toActionClassification('Governor Approved')).toBe('signed')
    expect(toActionClassification('Public Act . . . . . . . . . 104-0162')).toBe('signed')
    expect(toActionClassification('Governor Vetoed')).toBe('veto')
    expect(toActionClassification('Total Veto Stands - No Positive Action Taken')).toBe('veto')
    expect(toActionClassification('Governor Item/Reduction Veto PA 104-0464')).toBe('veto')
  })

  test('committee votes and motions are votes, not passages', () => {
    expect(toActionClassification('Do Pass Executive; 012-000-000')).toBe('vote')
    expect(
      toActionClassification('Do Pass as Amended / Short Debate Judiciary - Criminal Committee; 015-000-000'),
    ).toBe('vote')
    expect(toActionClassification('Motion Prevailed 071-000-000')).toBe('vote')
    expect(toActionClassification('Senate Concurs')).toBe('vote')
  })

  test('referral — including the re-referral that is how most IL bills quietly die', () => {
    expect(toActionClassification('Referred to Rules Committee')).toBe('referred')
    expect(toActionClassification('Referred to Assignments')).toBe('referred')
    expect(toActionClassification('Assigned to Executive Committee')).toBe('referred')
    expect(toActionClassification('Rule 3-9(a) / Re-referred to Assignments')).toBe('referred')
  })

  test('introduction', () => {
    expect(toActionClassification('Prefiled with Clerk by Rep. La Shawn K. Ford')).toBe('introduced')
    expect(toActionClassification('Filed with the Clerk by Rep. Bob Morgan')).toBe('introduced')
    expect(toActionClassification('First Reading')).toBe('introduced')
  })

  test('the uninteresting tail is `other` — quietly, because there is nothing to fix', () => {
    for (const action of [
      'Added Co-Sponsor Rep. Rita Mayfield',
      'Placed on Calendar Order of 3rd Reading May 15, 2025',
      'Arrived in House',
      'Sent to the Governor',
      'Effective Date January 1, 2028',
      'Second Reading - Short Debate',
      'Session Sine Die',
      '',
    ]) {
      expect(toActionClassification(action)).toBe('other')
    }
  })
})

describe('toBillType', () => {
  test('spells out the code — "B" is not vocabulary a human can read', () => {
    expect(toBillType('B')).toBe('bill')
    expect(toBillType('R')).toBe('resolution')
    expect(toBillType('JRCA')).toBe('joint resolution constitutional amendment')
  })

  test('an unrecognized code passes through rather than being dropped', () => {
    expect(toBillType('XYZ')).toBe('XYZ')
    expect(toBillType(null)).toBeNull()
  })
})

describe('toSponsorType / toOfficialRole', () => {
  test('sponsor_type_id 1 is the lead; everyone else co-sponsors', () => {
    expect(toSponsorType(1, 1)).toBe('primary')
    expect(toSponsorType(2, 4)).toBe('co')
    // Missing id, but LegiScan still orders the lead first.
    expect(toSponsorType(null, 1)).toBe('primary')
    expect(toSponsorType(null, 7)).toBe('co')
  })

  test('chamber comes from role_id, and an unreadable chamber is never guessed', () => {
    expect(toOfficialRole('Rep', 1)).toBe('state_rep')
    expect(toOfficialRole('Sen', 2)).toBe('state_sen')
    expect(toOfficialRole('Rep', null)).toBe('state_rep')

    const unmapped: string[] = []
    expect(toOfficialRole('Delegate', null, (_k, v) => unmapped.push(v))).toBe('other')
    expect(unmapped).toEqual(['Delegate'])
  })
})
