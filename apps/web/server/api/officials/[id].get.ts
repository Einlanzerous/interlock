import {
  signalForStatus,
  type BillStatus,
  type ContactType,
  type OfficialRole,
  type OrgType,
  type Signal,
} from '@interlock/shared'
import { DatabaseError } from 'pg'
import { db } from '../../utils/db'

/**
 * One official, everything we know about them (ITLK-9, brief §6 / user flow C).
 *
 * The point of the CRM is that the three things an organizer holds in their head about
 * a person — how to reach them, what they've sponsored, what we've said to them — are
 * on one page instead of three. So this is one round trip, not three: the tabs are
 * rendered from a single payload.
 *
 * `sponsoredBills` carries the live signal rather than a stored one, for the same reason
 * the alert feed does: the signal is a function of the bill's canonical status right now,
 * and a copy of it would be a copy that can go stale.
 */

export interface OfficialCommittee {
  id: string
  name: string
  classification: string | null
  /** chair / vice-chair / member — source vocab, per the membership table. */
  role: string | null
}

export interface OfficialSponsoredBill {
  billId: string
  identifier: string
  title: string
  status: BillStatus
  signal: Signal
  jurisdiction: string
  sponsorType: string
  lastActionDate: string | null
  /** The stance we hold it with, if it's tracked at all (ITLK-8). */
  position: string | null
}

export interface OfficialLetter {
  id: string
  subject: string
  direction: string
  channel: string
  status: string
  /**
   * How this official featured in the exchange. Plural because they can feature more than
   * once — `letter_official`'s key is (letter, official, role), so the same person may be
   * both `recipient` and `cc` on one letter.
   */
  roles: string[]
  sentDate: string | null
  receivedDate: string | null
  followupDate: string | null
  followupDone: boolean
}

/** A person on staff at an org (ITLK-21) — the org detail page's people list. */
export interface OfficialStaffer {
  id: string
  fullName: string
  role: OfficialRole | null
  active: boolean
}

export interface OfficialDetail {
  id: string
  fullName: string
  /** person | org. An org has null role/seat and carries orgType + department instead. */
  contactType: ContactType
  role: OfficialRole | null
  orgType: OrgType | null
  department: string | null
  /** A person's affiliated org, if any — its id and name for a one-hop link. */
  orgId: string | null
  orgName: string | null
  party: string | null
  ward: number | null
  district: string | null
  email: string | null
  phone: string | null
  webFormUrl: string | null
  officeAddress: string | null
  relationshipNotes: string | null
  active: boolean
  manual: boolean
  createdAt: string
  updatedAt: string
  committees: OfficialCommittee[]
  sponsoredBills: OfficialSponsoredBill[]
  letters: OfficialLetter[]
  /** People affiliated to this contact — non-empty only when this contact is an org. */
  staff: OfficialStaffer[]
}

export default defineEventHandler(async (event): Promise<OfficialDetail> => {
  const id = getRouterParam(event, 'id')!
  const pool = db()

  try {
    const [official, committees, bills, letters, staff] = await Promise.all([
      pool.query<{
        id: string
        full_name: string
        contact_type: ContactType
        role: OfficialRole | null
        org_type: OrgType | null
        department: string | null
        org_id: string | null
        org_name: string | null
        party: string | null
        ward: number | null
        district: string | null
        email: string | null
        phone: string | null
        web_form_url: string | null
        office_address: string | null
        relationship_notes: string | null
        active: boolean
        manual: boolean
        created_at: string
        updated_at: string
      }>(
        // Self-join to name the affiliated org in the same round trip — a person's "at CDOT"
        // is one hop, so it costs no extra query.
        `select o.id, o.full_name, o.contact_type, o.role, o.org_type, o.department,
                o.org_id, org.full_name as org_name,
                o.party, o.ward, o.district, o.email, o.phone, o.web_form_url,
                o.office_address, o.relationship_notes, o.active,
                o.source_person_ids is null as manual, o.created_at, o.updated_at
         from official o
         left join official org on org.id = o.org_id
         where o.id = $1`,
        [id],
      ),

      pool.query<{ id: string; name: string; classification: string | null; role: string | null }>(
        `select c.id, c.name, c.classification, m.role
         from membership m
         join committee c on c.id = m.committee_id
         where m.official_id = $1
         order by c.name`,
        [id],
      ),

      pool.query<{
        bill_id: string
        identifier: string
        title: string
        status: BillStatus
        jurisdiction: string
        sponsor_type: string
        last_action_date: string | null
        position: string | null
      }>(
        `select b.id as bill_id, b.identifier, b.title, b.status, b.jurisdiction,
                s.sponsor_type, b.last_action_date::text, tb.position
         from sponsorship s
         join bill b on b.id = s.bill_id
         left join tracked_bill tb on tb.bill_id = b.id
         where s.official_id = $1
         order by b.last_action_date desc nulls last, b.identifier`,
        [id],
      ),

      // Newest first, by the date the exchange actually happened — a letter drafted last
      // week but sent today belongs at the top. Drafts have neither date, so they fall
      // back to created_at rather than sorting to the bottom forever.
      //
      // Grouped by letter, NOT one row per letter_official: that table's primary key is
      // (letter_id, official_id, role), so one person can legitimately be both `recipient`
      // and `cc` on the same letter — and a plain join would then list that letter twice on
      // their correspondence tab. The roles are aggregated into one field instead, which is
      // also what the reader wants to know ("we wrote to them, and copied them").
      pool.query<{
        id: string
        subject: string
        direction: string
        channel: string
        status: string
        roles: string[]
        sent_date: string | null
        received_date: string | null
        followup_date: string | null
        followup_done: boolean
      }>(
        // `lo.role::text`, not bare `lo.role`: node-postgres has no array parser registered
        // for a custom enum type, so array_agg over the enum comes back as the raw literal
        // string '{recipient,cc}' rather than an array. Casting to text lands a real string[].
        `select l.id, l.subject, l.direction, l.channel, l.status,
                array_agg(lo.role::text order by lo.role) as roles,
                l.sent_date::text, l.received_date::text,
                l.followup_date::text, l.followup_done
         from letter_official lo
         join letter l on l.id = lo.letter_id
         where lo.official_id = $1
         group by l.id
         order by coalesce(l.sent_date, l.received_date, l.created_at::date) desc,
                  l.created_at desc`,
        [id],
      ),

      // People affiliated to this contact. Empty for a person (nobody staffs a person);
      // for an org it's the roster of named contacts at it. Active first, then by name.
      pool.query<{ id: string; full_name: string; role: OfficialRole | null; active: boolean }>(
        `select id, full_name, role, active from official
         where org_id = $1
         order by active desc, full_name`,
        [id],
      ),
    ])

    const row = official.rows[0]
    if (!row) throw createError({ statusCode: 404, statusMessage: 'no such official' })

    return {
      id: row.id,
      fullName: row.full_name,
      contactType: row.contact_type,
      role: row.role,
      orgType: row.org_type,
      department: row.department,
      orgId: row.org_id,
      orgName: row.org_name,
      party: row.party,
      ward: row.ward,
      district: row.district,
      email: row.email,
      phone: row.phone,
      webFormUrl: row.web_form_url,
      officeAddress: row.office_address,
      relationshipNotes: row.relationship_notes,
      active: row.active,
      manual: row.manual,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      committees: committees.rows,
      sponsoredBills: bills.rows.map((b) => ({
        billId: b.bill_id,
        identifier: b.identifier,
        title: b.title,
        status: b.status,
        signal: signalForStatus(b.status),
        jurisdiction: b.jurisdiction,
        sponsorType: b.sponsor_type,
        lastActionDate: b.last_action_date,
        position: b.position,
      })),
      letters: letters.rows.map((l) => ({
        id: l.id,
        subject: l.subject,
        direction: l.direction,
        channel: l.channel,
        status: l.status,
        roles: l.roles,
        sentDate: l.sent_date,
        receivedDate: l.received_date,
        followupDate: l.followup_date,
        followupDone: l.followup_done,
      })),
      staff: staff.rows.map((s) => ({
        id: s.id,
        fullName: s.full_name,
        role: s.role,
        active: s.active,
      })),
    }
  } catch (err) {
    // A non-uuid :id is a 404, not a 500 — the route matched, the person doesn't exist.
    if (err instanceof DatabaseError && err.code === '22P02') {
      throw createError({ statusCode: 404, statusMessage: 'no such official' })
    }
    throw err
  }
})
