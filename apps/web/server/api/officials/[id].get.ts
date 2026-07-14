import {
  signalForStatus,
  type BillStatus,
  type OfficialRole,
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
  /** recipient / sender / cc — how this official featured in the exchange. */
  role: string
  sentDate: string | null
  receivedDate: string | null
  followupDate: string | null
  followupDone: boolean
}

export interface OfficialDetail {
  id: string
  fullName: string
  role: OfficialRole
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
}

export default defineEventHandler(async (event): Promise<OfficialDetail> => {
  const id = getRouterParam(event, 'id')!
  const pool = db()

  try {
    const [official, committees, bills, letters] = await Promise.all([
      pool.query<{
        id: string
        full_name: string
        role: OfficialRole
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
        `select id, full_name, role, party, ward, district, email, phone, web_form_url,
                office_address, relationship_notes, active,
                source_person_ids is null as manual, created_at, updated_at
         from official where id = $1`,
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
      pool.query<{
        id: string
        subject: string
        direction: string
        channel: string
        status: string
        role: string
        sent_date: string | null
        received_date: string | null
        followup_date: string | null
        followup_done: boolean
      }>(
        `select l.id, l.subject, l.direction, l.channel, l.status, lo.role,
                l.sent_date::text, l.received_date::text,
                l.followup_date::text, l.followup_done
         from letter_official lo
         join letter l on l.id = lo.letter_id
         where lo.official_id = $1
         order by coalesce(l.sent_date, l.received_date, l.created_at::date) desc,
                  l.created_at desc`,
        [id],
      ),
    ])

    const row = official.rows[0]
    if (!row) throw createError({ statusCode: 404, statusMessage: 'no such official' })

    return {
      id: row.id,
      fullName: row.full_name,
      role: row.role,
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
        role: l.role,
        sentDate: l.sent_date,
        receivedDate: l.received_date,
        followupDate: l.followup_date,
        followupDone: l.followup_done,
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
