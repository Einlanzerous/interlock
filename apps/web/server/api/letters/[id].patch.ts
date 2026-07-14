import { LETTER_CHANNELS, LETTER_DIRECTIONS, LETTER_STATUSES } from '@interlock/shared'
import { DatabaseError } from 'pg'
import { db } from '../../utils/db'
import { parseBillIds, parseOfficialLinks, writeLinks } from '../../utils/letters'

/**
 * Edit a letter, or move it along (ITLK-10).
 *
 * This is the one route behind two very different gestures: reopening the compose drawer
 * to fix a typo, and clicking a status straight from a ledger row. They're the same write —
 * the row is small enough that a PATCH is a PATCH — so `draft → sent → responded → closed`
 * is reachable from the ledger without a second endpoint that could disagree with this one.
 *
 * Links are only touched if the body names them: `PATCH {status}` from a ledger row must
 * not silently unlink every official on the letter, which a blind delete-then-insert would.
 *
 * PATCH /api/letters/:id
 */

export interface LetterUpdated {
  id: string
  updated: string[]
}

const COLUMNS: Record<string, string> = {
  direction: 'direction',
  channel: 'channel',
  status: 'status',
  subject: 'subject',
  body: 'body',
  sentDate: 'sent_date',
  receivedDate: 'received_date',
  followupDate: 'followup_date',
  followupDone: 'followup_done',
}

const ENUMS: Record<string, readonly string[]> = {
  direction: LETTER_DIRECTIONS,
  channel: LETTER_CHANNELS,
  status: LETTER_STATUSES,
}

function day(value: unknown, field: string): string | null {
  if (value == null || String(value).trim() === '') return null
  const raw = String(value).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw createError({ statusCode: 400, statusMessage: `${field} must be a YYYY-MM-DD date` })
  }
  return raw
}

export default defineEventHandler(async (event): Promise<LetterUpdated> => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<Record<string, unknown>>(event)
  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, statusMessage: 'body is required' })
  }

  const keys = Object.keys(body).filter((k) => k in COLUMNS)
  const relinkOfficials = 'officials' in body
  const relinkBills = 'billIds' in body

  if (keys.length === 0 && !relinkOfficials && !relinkBills) {
    throw createError({
      statusCode: 400,
      statusMessage: `nothing to update — send one of: ${Object.keys(COLUMNS).join(', ')}, officials, billIds`,
    })
  }

  for (const key of keys) {
    const allowed = ENUMS[key]
    if (allowed && !allowed.includes(String(body[key]))) {
      throw createError({
        statusCode: 400,
        statusMessage: `${key} must be one of: ${allowed.join(', ')}`,
      })
    }
  }
  if ('subject' in body && !String(body.subject ?? '').trim()) {
    throw createError({ statusCode: 400, statusMessage: 'subject cannot be blank' })
  }

  const officials = relinkOfficials ? parseOfficialLinks(body.officials) : []
  const billIds = relinkBills ? parseBillIds(body.billIds) : []

  const client = await db().connect()
  try {
    await client.query('begin')

    const { rows: existing } = await client.query<{
      direction: string
      sent_date: string | null
      received_date: string | null
    }>(`select direction, sent_date::text, received_date::text from letter where id = $1 for update`, [id])
    if (!existing[0]) {
      throw createError({ statusCode: 404, statusMessage: 'no such letter' })
    }

    const values: Record<string, unknown> = {
      direction: body.direction,
      channel: body.channel,
      status: body.status,
      subject: String(body.subject ?? '').trim(),
      body: String(body.body ?? '').trim() || null,
      sentDate: day(body.sentDate, 'sentDate'),
      receivedDate: day(body.receivedDate, 'receivedDate'),
      followupDate: day(body.followupDate, 'followupDate'),
      followupDone: body.followupDone === true,
    }

    const sets = keys.map((k, i) => `${COLUMNS[k]} = $${i + 2}`)
    const params: unknown[] = keys.map((k) => values[k])

    // Moving a letter off `draft` from a ledger row stamps the date if it hasn't got one,
    // for the same reason POST does: the ledger sorts by that date, and a sent letter that
    // happened at no time sorts nowhere.
    if (keys.includes('status') && body.status !== 'draft' && !keys.includes('sentDate') && !keys.includes('receivedDate')) {
      const direction = (keys.includes('direction') ? body.direction : existing[0].direction) as string
      const column = direction === 'sent' ? 'sent_date' : 'received_date'
      const current = direction === 'sent' ? existing[0].sent_date : existing[0].received_date
      if (!current) {
        sets.push(`${column} = current_date`)
      }
    }

    if (sets.length > 0) {
      await client.query(`update letter set ${sets.join(', ')} where id = $1`, [id, ...params])
    }

    // Only rewrite the links the caller actually named — see the note above.
    if (relinkOfficials || relinkBills) {
      const { rows: current } = await client.query<{ official_id: string; role: string }>(
        `select official_id, role from letter_official where letter_id = $1`,
        [id],
      )
      const { rows: currentBills } = await client.query<{ bill_id: string }>(
        `select bill_id from letter_bill where letter_id = $1`,
        [id],
      )
      await writeLinks(
        client,
        id,
        relinkOfficials
          ? officials
          : current.map((r) => ({ officialId: r.official_id, role: r.role as 'recipient' })),
        relinkBills ? billIds : currentBills.map((r) => r.bill_id),
      )
    }

    await client.query('commit')
    return { id, updated: [...keys, ...(relinkOfficials ? ['officials'] : []), ...(relinkBills ? ['billIds'] : [])] }
  } catch (err) {
    await client.query('rollback')
    if (err instanceof DatabaseError && err.code === '22P02') {
      throw createError({ statusCode: 404, statusMessage: 'no such letter' })
    }
    if (err instanceof DatabaseError && err.code === '23503') {
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
