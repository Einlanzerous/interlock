import { Pool } from 'pg'
import { ChiClerkClient } from '../sources/chi_clerk/client'
import { makeNormalizer, type StagedRecord } from '../seam/pipeline'

/**
 * Acceptance / dev tool (ITLK-15): replay already-staged `source_record` rows through
 * the real pipeline, without re-hitting any upstream API.
 *
 * The staged payloads are the expensive thing to obtain (rate-limited detail fetches);
 * once they're in `source_record` they're a fixed corpus. This tool rebuilds the canonical
 * tables from that corpus so map/adapter changes can be validated against real data in
 * seconds instead of re-polling for many minutes. It also processes persons and bodies
 * before matters, so sponsor→official matching runs with the officials already present —
 * the steady state a live box is always in after its first full poll.
 *
 *   bun packages/worker/src/tools/reingest.ts prime   # fetch+stage eLMS persons & bodies
 *   bun packages/worker/src/tools/reingest.ts replay  # truncate canonical, replay staged
 *
 * DATABASE_URL selects the target DB (point it at a throwaway acceptance DB, never prod).
 */

const KIND_ORDER = ['person', 'body', 'matter', 'bill'] as const

async function prime(pool: Pool): Promise<void> {
  const client = new ChiClerkClient({
    baseUrl: process.env.CHI_CLERK_BASE_URL ?? 'https://api.chicityclerkelms.chicago.gov',
    maxRps: Number(process.env.CHI_CLERK_MAX_RPS ?? 4),
  })
  for (const kind of ['person', 'body'] as const) {
    let skip = 0
    let staged = 0
    for (;;) {
      const page = await client.list(kind, { top: 100, skip, sort: 'lastPublicationDate desc' })
      for (const row of page.data) {
        const id = row[kind === 'person' ? 'personId' : 'bodyId']
        if (typeof id !== 'string' || !id) continue
        const lpd = typeof row.lastPublicationDate === 'string' ? row.lastPublicationDate : null
        // Idempotent: one staged observation per (source_id) is enough for replay.
        const res = await pool.query(
          `insert into source_record (source, source_id, kind, payload, change_hash)
           select 'chi_clerk', $1, $2, $3, $4
           where not exists (select 1 from source_record where source='chi_clerk' and source_id=$1 and kind=$2)`,
          [id, kind, JSON.stringify(row), lpd],
        )
        staged += res.rowCount ?? 0
      }
      skip += page.data.length
      if (skip >= page.meta.count || page.data.length === 0) break
    }
    console.log(`[reingest] primed ${staged} new ${kind} record(s)`)
  }
}

async function replay(pool: Pool, truncate = true): Promise<void> {
  // Derived tables only — source_record / fetch_cursor / api_budget are the inputs, kept.
  // `keep` skips the truncate so a second pass exercises re-poll idempotency (ITLK-15 box 4):
  // the adapters short-circuit unchanged records, so nothing new should land.
  if (truncate) {
    await pool.query(
      `truncate bill, bill_action, sponsorship, official, committee, membership,
               alert, tracked_bill, letter, letter_bill, letter_official
       restart identity cascade`,
    )
  }
  const normalize = makeNormalizer(pool)

  let ok = 0
  let failed = 0
  for (const kind of KIND_ORDER) {
    const { rows } = await pool.query(
      `select id, source, source_id, kind, payload, change_hash
       from source_record where kind = $1 order by id`,
      [kind],
    )
    for (const row of rows) {
      const record: StagedRecord = {
        id: Number(row.id),
        source: row.source,
        sourceId: row.source_id,
        kind: row.kind,
        payload: row.payload,
        changeHash: row.change_hash,
      }
      try {
        await normalize(record)
        ok += 1
      } catch (err) {
        failed += 1
        console.error(`[reingest] FAILED ${record.source}/${record.kind} ${record.sourceId}:`, err)
      }
    }
    console.log(`[reingest] ${kind}: replayed ${rows.length}`)
  }
  console.log(`[reingest] done — ${ok} ok, ${failed} failed`)
}

/**
 * Inject a real-shaped movement onto one already-ingested LegiScan bill and run it through
 * the pipeline (ITLK-15 box 3). Appends a new history action and advances the status, stages
 * it as a fresh observation, and normalizes it — so the Differ sees a genuine delta against
 * canonical state and fires alerts for a tracked bill exactly as a live poll would.
 */
async function bump(pool: Pool, sourceBillId: string): Promise<void> {
  const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
    `select payload from source_record
     where source='legiscan_il' and source_id=$1 order by id desc limit 1`,
    [sourceBillId],
  )
  if (!rows[0]) throw new Error(`no staged legiscan_il record for ${sourceBillId}`)
  const payload = rows[0].payload
  const history = Array.isArray(payload.history) ? payload.history : []
  const changeHash = `accept-bump-${history.length + 1}`
  payload.status = 4 // LegiScan 4 = Passed
  payload.history = [
    ...history,
    { date: '2026-07-15', action: 'ACCEPTANCE-TEST Third Reading - Passed', chamber: 'H', importance: 1 },
  ]
  // The LegiScan adapter keys its short-circuit on payload.change_hash, so a real movement
  // must carry a fresh one — otherwise the bill reads as unchanged and nothing re-processes.
  payload.change_hash = changeHash
  const {
    rows: [staged],
  } = await pool.query<{ id: string }>(
    `insert into source_record (source, source_id, kind, payload, change_hash)
     values ('legiscan_il', $1, 'bill', $2, $3) returning id`,
    [sourceBillId, JSON.stringify(payload), changeHash],
  )
  await makeNormalizer(pool)({
    id: Number(staged!.id),
    source: 'legiscan_il',
    sourceId: sourceBillId,
    kind: 'bill',
    payload,
    changeHash,
  })
  console.log(`[reingest] bumped legiscan_il ${sourceBillId} (status→Passed, +1 action)`)
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'replay'
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    if (mode === 'prime') await prime(pool)
    else if (mode === 'replay') await replay(pool, process.argv[3] !== 'keep')
    else if (mode === 'bump') await bump(pool, process.argv[3]!)
    else throw new Error(`unknown mode '${mode}' (want: prime | replay [keep] | bump <id>)`)
  } finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  console.error('[reingest] fatal', err)
  process.exit(1)
})
