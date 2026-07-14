import { DatabaseError } from 'pg'
import { db } from '../../utils/db'
import { parseBillIds, parseLetter, parseOfficialLinks, writeLinks } from '../../utils/letters'

/**
 * Log a letter (ITLK-10, user flow B).
 *
 * "Letter" is the schema's word for any exchange: an email, a posted letter, a web-form
 * submission, a phone call, a conversation on a doorstep. A logged call is a first-class
 * row — direction `received`, channel `phone`, notes in the body, no send date, no
 * email-shaped field required of it.
 *
 * The letter and its links land in one transaction. A letter that exists but names nobody
 * is a letter the ledger would show and the officials' correspondence tabs would not, and
 * the organizer would have no way to tell which of the two was lying.
 *
 * POST /api/letters
 *   { direction, channel, subject, body?, status?, sentDate?, receivedDate?, followupDate?,
 *     officials?: [{ officialId, role }], billIds?: [] }
 */

export interface LetterCreated {
  id: string
}

export default defineEventHandler(async (event): Promise<LetterCreated> => {
  const body = await readBody<Record<string, unknown>>(event)

  const fields = parseLetter(body)
  const officials = parseOfficialLinks(body?.officials)
  const billIds = parseBillIds(body?.billIds)

  // A letter marked sent with no send date is a hole in the ledger — and the ledger sorts
  // by that date. Stamp today rather than record an exchange that happened at no time.
  const today = new Date().toISOString().slice(0, 10)
  const sentDate = fields.sentDate ?? (fields.status !== 'draft' && fields.direction === 'sent' ? today : null)
  const receivedDate =
    fields.receivedDate ?? (fields.status !== 'draft' && fields.direction === 'received' ? today : null)

  const client = await db().connect()
  try {
    await client.query('begin')

    const { rows } = await client.query<{ id: string }>(
      `insert into letter
         (direction, channel, status, subject, body, sent_date, received_date,
          followup_date, followup_done)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        fields.direction,
        fields.channel,
        fields.status,
        fields.subject,
        fields.body,
        sentDate,
        receivedDate,
        fields.followupDate,
        fields.followupDone,
      ],
    )
    const id = rows[0]!.id

    await writeLinks(client, id, officials, billIds)
    await client.query('commit')
    return { id }
  } catch (err) {
    await client.query('rollback')
    if (err instanceof DatabaseError && (err.code === '23503' || err.code === '22P02')) {
      // FK violation or a malformed uuid — an official or bill that isn't there.
      throw createError({
        statusCode: 400,
        statusMessage: 'an official or bill on this letter does not exist',
      })
    }
    throw err
  } finally {
    client.release()
  }
})
