import {
  signalForStatus,
  type ActionClassification,
  type BillStatus,
  type Jurisdiction,
  type Signal,
} from '@interlock/shared'
import { DatabaseError } from 'pg'
import { db } from '../../utils/db'

/**
 * One bill, whole (ITLK-11, brief §6 / user flow A): where it stands, how it got there, who
 * put it there, and everything we've said about it.
 */

export interface BillAction {
  id: string
  sequence: number
  actionDate: string
  description: string
  classification: ActionClassification
  actor: string | null
}

export interface BillSponsor {
  sponsorshipId: string
  /** Null when the matcher would not guess — the row renders as plain text, not a link. */
  officialId: string | null
  /** The verbatim name from the source. What an unmatched sponsor is shown as. */
  sponsorName: string
  /** The CRM's name for them, when they resolved to someone. */
  fullName: string | null
  role: string | null
  ward: number | null
  district: string | null
  party: string | null
  sponsorType: string
  sequence: number | null
  matchMethod: string | null
  matchConfidence: number | null
}

export interface BillLetter {
  id: string
  subject: string
  direction: string
  channel: string
  status: string
  /** correspondence | letter_to_editor | op_ed — a media placement about this bill (ITLK-23). */
  kind: string
  sentDate: string | null
  receivedDate: string | null
  publishedDate: string | null
}

export interface BillDetail {
  id: string
  identifier: string
  title: string
  summary: string | null
  status: BillStatus
  signal: Signal
  source: string
  jurisdiction: Jurisdiction
  session: string | null
  billType: string | null
  committee: { id: string; name: string } | null
  introducedDate: string | null
  lastActionText: string | null
  lastActionDate: string | null
  sourceUrl: string | null
  fullTextUrl: string | null
  tracked: {
    id: string
    position: string
    priority: number
    notes: string | null
    alertChannel: string
  } | null
  unreadAlerts: number
  actions: BillAction[]
  sponsors: BillSponsor[]
  letters: BillLetter[]
}

export default defineEventHandler(async (event): Promise<BillDetail> => {
  const id = getRouterParam(event, 'id')!
  const pool = db()

  try {
    const [bill, actions, sponsors, letters] = await Promise.all([
      pool.query<{
        id: string
        identifier: string
        title: string
        summary: string | null
        status: BillStatus
        source: string
        jurisdiction: Jurisdiction
        session: string | null
        bill_type: string | null
        committee_id: string | null
        committee_name: string | null
        introduced_date: string | null
        last_action_text: string | null
        last_action_date: string | null
        source_url: string | null
        full_text_url: string | null
        tracked_id: string | null
        position: string | null
        priority: number | null
        notes: string | null
        alert_channel: string | null
        unread_alerts: string
      }>(
        `select b.id, b.identifier, b.title, b.summary, b.status, b.source, b.jurisdiction,
                b.session, b.bill_type, b.committee_id, c.name as committee_name,
                b.introduced_date::text, b.last_action_text, b.last_action_date::text,
                b.source_url, b.full_text_url,
                tb.id as tracked_id, tb.position, tb.priority, tb.notes, tb.alert_channel,
                (select count(*) from alert a where a.bill_id = b.id and a.read_at is null)
                  as unread_alerts
         from bill b
         left join committee c on c.id = b.committee_id
         left join tracked_bill tb on tb.bill_id = b.id
         where b.id = $1`,
        [id],
      ),

      // The timeline, newest first — the brief's spine runs accent (now) → line (then).
      pool.query<{
        id: string
        sequence: number
        action_date: string
        description: string
        classification: ActionClassification
        actor: string | null
      }>(
        `select id, sequence, action_date::text, description, classification, actor
         from bill_action
         where bill_id = $1
         order by action_date desc, sequence desc`,
        [id],
      ),

      // Sponsors, matched or not. An unmatched sponsor is still a sponsor: the source said
      // they put their name on this. It renders as plain text rather than being hidden,
      // because hiding it would misreport the bill (and the review queue exists precisely
      // so those rows are resolvable rather than lost).
      pool.query<{
        sponsorship_id: string
        official_id: string | null
        sponsor_name: string
        full_name: string | null
        role: string | null
        ward: number | null
        district: string | null
        party: string | null
        sponsor_type: string
        sequence: number | null
        match_method: string | null
        match_confidence: number | null
      }>(
        `select s.id as sponsorship_id, s.official_id, s.sponsor_name, s.sponsor_type,
                s.sequence, s.match_method, s.match_confidence,
                o.full_name, o.role, o.ward, o.district, o.party
         from sponsorship s
         left join official o on o.id = s.official_id
         where s.bill_id = $1
         order by
           case s.sponsor_type when 'primary' then 0 when 'chief_co' then 1 else 2 end,
           s.sequence nulls last,
           s.sponsor_name`,
        [id],
      ),

      pool.query<{
        id: string
        subject: string
        direction: string
        channel: string
        status: string
        kind: string
        sent_date: string | null
        received_date: string | null
        published_date: string | null
      }>(
        `select l.id, l.subject, l.direction, l.channel, l.status, l.kind,
                l.sent_date::text, l.received_date::text, l.published_date::text
         from letter_bill lb
         join letter l on l.id = lb.letter_id
         where lb.bill_id = $1
         order by coalesce(l.published_date, l.sent_date, l.received_date, l.created_at::date) desc,
                  l.created_at desc`,
        [id],
      ),
    ])

    const row = bill.rows[0]
    if (!row) throw createError({ statusCode: 404, statusMessage: 'no such bill' })

    return {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      summary: row.summary,
      status: row.status,
      signal: signalForStatus(row.status),
      source: row.source,
      jurisdiction: row.jurisdiction,
      session: row.session,
      billType: row.bill_type,
      committee:
        row.committee_id && row.committee_name
          ? { id: row.committee_id, name: row.committee_name }
          : null,
      introducedDate: row.introduced_date,
      lastActionText: row.last_action_text,
      lastActionDate: row.last_action_date,
      sourceUrl: row.source_url,
      fullTextUrl: row.full_text_url,
      tracked: row.tracked_id
        ? {
            id: row.tracked_id,
            position: row.position!,
            priority: row.priority!,
            notes: row.notes,
            alertChannel: row.alert_channel!,
          }
        : null,
      unreadAlerts: Number(row.unread_alerts),
      actions: actions.rows.map((a) => ({
        id: a.id,
        sequence: a.sequence,
        actionDate: a.action_date,
        description: a.description,
        classification: a.classification,
        actor: a.actor,
      })),
      sponsors: sponsors.rows.map((s) => ({
        sponsorshipId: s.sponsorship_id,
        officialId: s.official_id,
        sponsorName: s.sponsor_name,
        fullName: s.full_name,
        role: s.role,
        ward: s.ward,
        district: s.district,
        party: s.party,
        sponsorType: s.sponsor_type,
        sequence: s.sequence,
        matchMethod: s.match_method,
        matchConfidence: s.match_confidence,
      })),
      letters: letters.rows.map((l) => ({
        id: l.id,
        subject: l.subject,
        direction: l.direction,
        channel: l.channel,
        status: l.status,
        kind: l.kind,
        sentDate: l.sent_date,
        receivedDate: l.received_date,
        publishedDate: l.published_date,
      })),
    }
  } catch (err) {
    if (err instanceof DatabaseError && err.code === '22P02') {
      throw createError({ statusCode: 404, statusMessage: 'no such bill' })
    }
    throw err
  }
})
