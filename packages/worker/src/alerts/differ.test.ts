import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { migrate } from '@interlock/db'
import { makeNormalizer, type StagedRecord } from '../seam/pipeline'
import { makeAlerter, type AlertChannelPort, type AlertDelivery } from './deliver'

/**
 * ITLK-8 acceptance criteria, against a real Postgres (throwaway DB per run,
 * same pattern as the seam tests). The epic's One Metric — a tracked bill
 * cannot move without an alert firing — and its inverse: an untracked bill,
 * or a watermark bump with no semantic change, must fire nothing.
 */

const adminUrl = process.env.DATABASE_URL
if (!adminUrl) {
  console.warn('[differ test] DATABASE_URL not set — skipping differ integration tests')
}

const TEST_DB = `interlock_alerts_${randomUUID().slice(0, 8)}`

let adminPool: Pool
let pool: Pool

// ---------------------------------------------------------------------------
// payload builders — realistic eLMS matter shapes, minimal fields
// ---------------------------------------------------------------------------

interface MatterOptions {
  matterId?: string
  publishedAt: string
  status?: string
  subStatus?: string
  actions?: Array<Record<string, unknown>>
  sponsors?: Array<Record<string, unknown>>
}

function matter(options: MatterOptions): Record<string, unknown> {
  return {
    matterId: options.matterId ?? 'matter-differ-1',
    recordNumber: 'O2026-0100',
    title: 'Ordinance about alert plumbing',
    type: 'Ordinance',
    status: options.status ?? '4-In Committee',
    subStatus: options.subStatus,
    lastPublicationDate: options.publishedAt,
    introductionDate: '2026-06-01T05:00:00Z',
    fileYear: 2026,
    actions: options.actions ?? [INTRO_ACTION],
    sponsors: options.sponsors ?? [
      { sponsorName: 'Lopez, Raymond A.', sponsorType: 'Sponsor', personId: 'person-1', office: '15' },
    ],
  }
}

const INTRO_ACTION = {
  historyId: 'h-intro',
  actionDate: '2026-06-01T05:00:00Z',
  actionName: 'Council Introduction',
  actionText: 'Introduced by alderman',
  actionByName: 'City Council',
  sort: 70,
}

let nextRecordId = 1
function staged(payload: Record<string, unknown>): StagedRecord {
  return {
    id: nextRecordId++,
    source: 'chi_clerk',
    sourceId: String(payload.matterId),
    kind: 'matter',
    payload,
    changeHash: null,
  }
}

/** A recording stand-in for the SMTP channel. */
function fakeEmailChannel(): AlertChannelPort & { deliveries: AlertDelivery[] } {
  const deliveries: AlertDelivery[] = []
  return {
    channel: 'email',
    deliveries,
    async deliver(delivery) {
      deliveries.push(delivery)
    },
  }
}

async function track(
  matterId: string,
  alertChannel: 'in_app' | 'email' | 'both' = 'in_app',
): Promise<string> {
  const { rows } = await pool.query<{ bill_id: string }>(
    `insert into tracked_bill (bill_id, position, alert_channel)
     select id, 'support', $2::alert_channel from bill where source = 'chi_clerk' and source_bill_id = $1
     returning bill_id`,
    [matterId, alertChannel],
  )
  return rows[0]!.bill_id
}

async function alerts(matterId: string): Promise<Array<{ change_type: string; payload: Record<string, unknown>; delivered_channels: string[]; read_at: unknown }>> {
  const { rows } = await pool.query(
    `select a.change_type, a.payload, a.delivered_channels, a.read_at
     from alert a join bill b on b.id = a.bill_id
     where b.source = 'chi_clerk' and b.source_bill_id = $1
     order by a.created_at`,
    [matterId],
  )
  return rows
}

describe.skipIf(!adminUrl)('differ + alerter (ITLK-8)', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl, max: 1 })
    await adminPool.query(`create database ${TEST_DB}`)
    const testUrl = new URL(adminUrl!)
    testUrl.pathname = `/${TEST_DB}`
    pool = new Pool({ connectionString: testUrl.toString(), max: 4 })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool?.end()
    await adminPool?.query(`drop database if exists ${TEST_DB} with (force)`)
    await adminPool?.end()
  })

  test('untracked bill: changes update canonical data but fire no alert', async () => {
    const normalize = makeNormalizer(pool)
    await normalize(staged(matter({ matterId: 'untracked-1', publishedAt: '2026-07-01T00:00:00Z' })))
    await normalize(
      staged(
        matter({
          matterId: 'untracked-1',
          publishedAt: '2026-07-02T00:00:00Z',
          actions: [
            INTRO_ACTION,
            { historyId: 'h-2', actionDate: '2026-07-02T05:00:00Z', actionName: 'Referred', actionByName: 'Committee on Finance', sort: 71 },
          ],
        }),
      ),
    )

    const { rows } = await pool.query(
      `select count(*)::int as n from bill_action ba join bill b on b.id = ba.bill_id
       where b.source_bill_id = 'untracked-1'`,
    )
    expect(rows[0]!.n).toBe(2) // canonical data still updates
    expect(await alerts('untracked-1')).toHaveLength(0)
  })

  test('tracked bill + new action → exactly one new_action alert, delivered in-app', async () => {
    const normalize = makeNormalizer(pool)
    await normalize(staged(matter({ matterId: 'tracked-1', publishedAt: '2026-07-01T00:00:00Z' })))
    await track('tracked-1')

    await normalize(
      staged(
        matter({
          matterId: 'tracked-1',
          publishedAt: '2026-07-03T00:00:00Z',
          actions: [
            INTRO_ACTION,
            { historyId: 'h-ref', actionDate: '2026-07-03T05:00:00Z', actionName: 'Referred', actionText: 'Referred to Finance', actionByName: 'City Council', sort: 71 },
          ],
        }),
      ),
    )

    const fired = await alerts('tracked-1')
    expect(fired).toHaveLength(1)
    expect(fired[0]!.change_type).toBe('new_action')
    expect(fired[0]!.delivered_channels).toEqual(['in_app'])
    expect(fired[0]!.read_at).toBeNull()
    const actions = fired[0]!.payload.actions as Array<Record<string, unknown>>
    expect(actions).toHaveLength(1)
    expect(actions[0]!.description).toBe('Referred to Finance')
  })

  test('watermark bump with no semantic change fires nothing', async () => {
    const normalize = makeNormalizer(pool)
    // Same content as the last tracked-1 poll, fresher lastPublicationDate — the
    // Legistar-family failure mode the ticket calls out by name.
    await normalize(
      staged(
        matter({
          matterId: 'tracked-1',
          publishedAt: '2026-07-04T00:00:00Z',
          actions: [
            INTRO_ACTION,
            { historyId: 'h-ref', actionDate: '2026-07-03T05:00:00Z', actionName: 'Referred', actionText: 'Referred to Finance', actionByName: 'City Council', sort: 71 },
          ],
        }),
      ),
    )
    expect(await alerts('tracked-1')).toHaveLength(1) // still just the one from before
  })

  test('same upstream change processed twice → no duplicate alert', async () => {
    const normalize = makeNormalizer(pool)
    // Identical payload including the watermark: the adapter short-circuits, the
    // differ sees an empty diff.
    const replay = matter({
      matterId: 'tracked-1',
      publishedAt: '2026-07-04T00:00:00Z',
      actions: [
        INTRO_ACTION,
        { historyId: 'h-ref', actionDate: '2026-07-03T05:00:00Z', actionName: 'Referred', actionText: 'Referred to Finance', actionByName: 'City Council', sort: 71 },
      ],
    })
    await normalize(staged(replay))
    await normalize(staged(replay))
    expect(await alerts('tracked-1')).toHaveLength(1)
  })

  test('status flip → status_change alert carrying both signal vocabularies', async () => {
    const normalize = makeNormalizer(pool)
    await normalize(staged(matter({ matterId: 'status-1', publishedAt: '2026-07-01T00:00:00Z' })))
    await track('status-1')

    await normalize(
      staged(
        matter({
          matterId: 'status-1',
          publishedAt: '2026-07-05T00:00:00Z',
          status: '90-Final',
          subStatus: 'Passed',
        }),
      ),
    )

    const fired = await alerts('status-1')
    expect(fired).toHaveLength(1)
    expect(fired[0]!.change_type).toBe('status_change')
    expect(fired[0]!.payload).toEqual({
      from: 'in_committee',
      to: 'passed',
      fromSignal: 'caution',
      toSignal: 'clear',
    })
  })

  test('vote and hearing actions file under their own change types', async () => {
    const normalize = makeNormalizer(pool)
    await normalize(staged(matter({ matterId: 'vote-1', publishedAt: '2026-07-01T00:00:00Z' })))
    await track('vote-1')

    await normalize(
      staged(
        matter({
          matterId: 'vote-1',
          publishedAt: '2026-07-06T00:00:00Z',
          actions: [
            INTRO_ACTION,
            { historyId: 'h-hold', actionDate: '2026-07-05T05:00:00Z', actionName: 'Held in Committee', actionByName: 'Committee on Finance', sort: 71 },
            { historyId: 'h-rec', actionDate: '2026-07-06T05:00:00Z', actionName: 'Recommended to Pass', actionByName: 'Committee on Finance', sort: 72 },
          ],
        }),
      ),
    )

    const fired = await alerts('vote-1')
    const types = fired.map((a) => a.change_type).sort()
    expect(types).toEqual(['hearing', 'vote'])
  })

  test('new sponsor → new_sponsor alert', async () => {
    const normalize = makeNormalizer(pool)
    await normalize(staged(matter({ matterId: 'sponsor-1', publishedAt: '2026-07-01T00:00:00Z' })))
    await track('sponsor-1')

    await normalize(
      staged(
        matter({
          matterId: 'sponsor-1',
          publishedAt: '2026-07-07T00:00:00Z',
          sponsors: [
            { sponsorName: 'Lopez, Raymond A.', sponsorType: 'Sponsor', personId: 'person-1', office: '15' },
            { sponsorName: 'Vasquez, Andre', sponsorType: 'CoSponsor', personId: 'person-2', office: '40' },
          ],
        }),
      ),
    )

    const fired = await alerts('sponsor-1')
    expect(fired).toHaveLength(1)
    expect(fired[0]!.change_type).toBe('new_sponsor')
    expect(fired[0]!.payload.sponsors).toEqual([{ name: 'Vasquez, Andre', type: 'co' }])
  })

  test('email channel: delivered when configured and elected, recorded in delivered_channels', async () => {
    const email = fakeEmailChannel()
    const normalize = makeNormalizer(pool, undefined, makeAlerter(pool, [email]))
    await normalize(staged(matter({ matterId: 'email-1', publishedAt: '2026-07-01T00:00:00Z' })))
    await track('email-1', 'both')

    await normalize(
      staged(
        matter({
          matterId: 'email-1',
          publishedAt: '2026-07-08T00:00:00Z',
          status: '90-Final',
          subStatus: 'Passed',
        }),
      ),
    )

    expect(email.deliveries).toHaveLength(1)
    expect(email.deliveries[0]!.bill.identifier).toBe('O2026-0100')
    const fired = await alerts('email-1')
    expect(fired).toHaveLength(1)
    expect(fired[0]!.delivered_channels.sort()).toEqual(['email', 'in_app'])
  })

  test('email channel skipped when the tracking says in_app only', async () => {
    const email = fakeEmailChannel()
    const normalize = makeNormalizer(pool, undefined, makeAlerter(pool, [email]))
    await normalize(staged(matter({ matterId: 'email-2', publishedAt: '2026-07-01T00:00:00Z' })))
    await track('email-2', 'in_app')

    await normalize(
      staged(matter({ matterId: 'email-2', publishedAt: '2026-07-08T00:00:00Z', status: '90-Final', subStatus: 'Passed' })),
    )

    expect(email.deliveries).toHaveLength(0)
    const fired = await alerts('email-2')
    expect(fired[0]!.delivered_channels).toEqual(['in_app'])
  })

  test('a channel that throws is logged, not fatal — the alert stays in-app', async () => {
    const broken: AlertChannelPort = {
      channel: 'email',
      async deliver() {
        throw new Error('SMTP 550: relay refused')
      },
    }
    const normalize = makeNormalizer(pool, undefined, makeAlerter(pool, [broken]))
    await normalize(staged(matter({ matterId: 'email-3', publishedAt: '2026-07-01T00:00:00Z' })))
    await track('email-3', 'email')

    // Must not throw: the alert row is already committed and visible in-app.
    await normalize(
      staged(matter({ matterId: 'email-3', publishedAt: '2026-07-08T00:00:00Z', status: '90-Final', subStatus: 'Passed' })),
    )

    const fired = await alerts('email-3')
    expect(fired).toHaveLength(1)
    expect(fired[0]!.delivered_channels).toEqual(['in_app'])
  })
})
