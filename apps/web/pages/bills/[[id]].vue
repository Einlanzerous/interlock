<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  BILL_STATUSES,
  SIGNAL_LABEL,
  TRACKED_POSITIONS,
  signalColor,
  type BillStatus,
  type Jurisdiction,
  type Signal,
  type TrackedPosition,
} from '@interlock/shared'

/**
 * The Bills screens (ITLK-11, brief §6 / user flow A).
 *
 * Two panes: search and facets on the left, the bill on the right, the bill marginally wider.
 * Same `[[id]]` shape as the CRM, so a bill is a URL — the ledger links at one, an alert
 * will, and the dashboard will.
 *
 * The Track button is anchored to the bottom of the detail pane, which is where the brief's
 * wireframe puts it: it is the one thing on this screen that *changes* something, and flow A
 * ends there. Tracking is a stance, not a subscription — `tracked_bill.bill_id` is UNIQUE, so
 * the button is a toggle-and-edit, never a duplicate-create.
 */

interface BillRow {
  id: string
  identifier: string
  title: string
  status: BillStatus
  signal: Signal
  jurisdiction: Jurisdiction
  committee: { id: string; name: string } | null
  lastActionText: string | null
  lastActionDate: string | null
  position: string | null
  unreadAlerts: number
}

interface Action {
  id: string
  actionDate: string
  description: string
  classification: string
  actor: string | null
}

interface Sponsor {
  sponsorshipId: string
  officialId: string | null
  sponsorName: string
  fullName: string | null
  role: string | null
  ward: number | null
  district: string | null
  sponsorType: string
  matchConfidence: number | null
}

interface BillLetter {
  id: string
  subject: string
  direction: string
  channel: string
  status: string
  sentDate: string | null
  receivedDate: string | null
}

interface BillDetail extends BillRow {
  summary: string | null
  source: string
  session: string | null
  billType: string | null
  introducedDate: string | null
  sourceUrl: string | null
  fullTextUrl: string | null
  tracked: {
    id: string
    position: TrackedPosition
    priority: number
    notes: string | null
    alertChannel: string
  } | null
  actions: Action[]
  sponsors: Sponsor[]
  letters: BillLetter[]
}

interface CommitteeOption {
  id: string
  name: string
  jurisdiction: Jurisdiction
  billCount: number
}

const route = useRoute()
const selectedId = computed(() => (route.params.id as string | undefined) || null)

/* ── Search + facets (left pane) ────────────────────────────────────────── */

/* `committeeId` and `position` seed from the URL: the bill detail's committee pill and the
   dashboard's tracked tiles (ITLK-12) both land here pre-filtered, and a filter you arrived
   by has to be visible — and clearable — or the list looks broken. */
const filters = reactive({
  q: '',
  jurisdiction: '',
  status: '',
  committeeId: (route.query.committeeId as string) ?? '',
  position: (route.query.position as string) ?? '',
})

const { data: committees } = await useFetch<CommitteeOption[]>('/api/committees')

const { data: bills, pending: listPending } = await useFetch<BillRow[]>('/api/bills', {
  query: computed(() => ({
    q: filters.q || undefined,
    jurisdiction: filters.jurisdiction || undefined,
    status: filters.status || undefined,
    committeeId: filters.committeeId || undefined,
    position: filters.position || undefined,
  })),
})

const anyFilter = computed(
  () =>
    !!(
      filters.q ||
      filters.jurisdiction ||
      filters.status ||
      filters.committeeId ||
      filters.position
    ),
)
function clearFilters(): void {
  filters.position = ''
  filters.q = ''
  filters.jurisdiction = ''
  filters.status = ''
  filters.committeeId = ''
}

/* ── The bill (right pane) ──────────────────────────────────────────────── */

/**
 * Per-id key, for the reason spelled out on the CRM: `useAsyncData` caches by key, so a
 * constant key means clicking a row remounts the page, Nuxt finds the "nothing selected"
 * entry already under that key, skips the handler entirely — no request is even made — and
 * the pane renders empty. A direct load of /bills/:id works, which is what makes it easy to
 * ship. Clicking a row, the only way anyone uses this, does not.
 */
const {
  data: fetched,
  refresh: refreshDetail,
  pending: detailPending,
} = await useAsyncData(
  () => `bill-${selectedId.value ?? 'none'}`,
  async (): Promise<{ bill: BillDetail | null }> => {
    const id = selectedId.value
    if (!id) return { bill: null }
    return { bill: await $fetch<BillDetail>(`/api/bills/${id}`) }
  },
  { watch: [selectedId] },
)

const detail = computed(() => fetched.value?.bill ?? null)

/* ── Track (flow A, step 3) ─────────────────────────────────────────────── */

const picking = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const stance = reactive({ position: 'watch' as TrackedPosition, priority: 0, notes: '' })

watch(selectedId, () => {
  picking.value = false
  error.value = null
})

function openPicker(d: BillDetail): void {
  stance.position = d.tracked?.position ?? 'watch'
  stance.priority = d.tracked?.priority ?? 0
  stance.notes = d.tracked?.notes ?? ''
  picking.value = true
  error.value = null
}

async function saveTracking(d: BillDetail): Promise<void> {
  busy.value = true
  error.value = null
  try {
    const body = {
      position: stance.position,
      priority: Number(stance.priority) || 0,
      notes: stance.notes || null,
    }
    if (d.tracked) {
      await $fetch(`/api/tracked-bills/${d.tracked.id}`, { method: 'PATCH', body })
    } else {
      await $fetch('/api/tracked-bills', { method: 'POST', body: { billId: d.id, ...body } })
    }
    picking.value = false
    await Promise.all([refreshDetail(), refreshList()])
  } catch (err: unknown) {
    error.value = messageOf(err)
  } finally {
    busy.value = false
  }
}

/** The bill the untrack dialog is asking about. Null = no dialog. */
const untracking = ref<BillDetail | null>(null)

/**
 * Untracking is not a small button. It drops the position, the priority and the notes the
 * organizer typed, and it stops the worker watching — after which the bill can move without
 * an alert firing, which is the one thing this whole app exists to prevent. So it asks.
 */
async function untrack(): Promise<void> {
  const d = untracking.value
  if (!d?.tracked) return
  busy.value = true
  error.value = null
  try {
    await $fetch(`/api/tracked-bills/${d.tracked.id}`, { method: 'DELETE' })
    untracking.value = null
    picking.value = false
    await Promise.all([refreshDetail(), refreshList()])
  } catch (err: unknown) {
    error.value = messageOf(err)
    untracking.value = null
  } finally {
    busy.value = false
  }
}

/** The list carries the tracked marker, so it has to be re-read when tracking changes. */
async function refreshList(): Promise<void> {
  await refreshNuxtData()
}

function messageOf(err: unknown): string {
  const data = (err as { data?: { statusMessage?: string } })?.data
  return data?.statusMessage ?? (err instanceof Error ? err.message : String(err))
}

/* ── Presentation ───────────────────────────────────────────────────────── */

const SOURCE_LABEL: Record<string, string> = {
  chicago_council: 'Chicago Council',
  il_ga: 'Illinois GA',
}

const STATUS_LABEL: Record<string, string> = {
  in_committee: 'in committee',
}

function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s.replace(/_/g, ' ')
}

function day(iso: string | null): string {
  return iso ? new Date(`${iso}T00:00:00`).toLocaleDateString() : '—'
}

/** The seat, as a person would say it. */
function seat(s: Sponsor): string | null {
  if (s.ward != null) return `Ward ${s.ward}`
  return s.district || null
}
</script>

<template>
  <main>
    <h1>Bills</h1>
    <p class="muted intro">
      Every bill across both governments in one search box — the City Council and the Illinois
      General Assembly, found the same way.
    </p>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="panes">
      <!-- ── Search + list ──────────────────────────────────────────────── -->
      <section class="list">
        <div class="filters">
          <input v-model="filters.q" type="search" placeholder="Search titles, summaries, HB1234…" />
          <div class="filter-row">
            <select v-model="filters.jurisdiction">
              <option value="">Both sources</option>
              <option value="chicago_council">Chicago Council</option>
              <option value="il_ga">Illinois GA</option>
            </select>
            <select v-model="filters.status">
              <option value="">Any status</option>
              <option v-for="s in BILL_STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
            </select>
          </div>
          <select v-model="filters.committeeId">
            <option value="">Any committee</option>
            <option v-for="c in committees ?? []" :key="c.id" :value="c.id">
              {{ c.name }} ({{ c.billCount }})
            </option>
          </select>

          <!-- Arriving from a dashboard tile pre-filters the list. Say so, rather than let
               it look like the corpus only has four bills in it. -->
          <div v-if="filters.position" class="active-filter">
            <span class="label">Tracked</span>
            <span class="pill stance">{{ filters.position }}</span>
            <button class="x" title="Show every bill again" @click="filters.position = ''">×</button>
          </div>

          <button v-if="anyFilter" @click="clearFilters">Clear filters</button>
        </div>

        <p v-if="listPending && !bills" class="muted loading">Searching…</p>

        <p v-else-if="!bills?.length" class="empty">
          <span class="label">Nothing found</span>
          <span class="muted">
            {{ anyFilter ? 'No bill matches. Loosen the filters.' : 'No bills ingested yet.' }}
          </span>
        </p>

        <ul v-else class="rows">
          <li v-for="b in bills" :key="b.id">
            <NuxtLink :to="`/bills/${b.id}`" :class="{ on: b.id === selectedId }">
              <SignalDot :signal="b.signal" :size="7" />
              <span class="row-body">
                <span class="row-top">
                  <span class="ident">{{ b.identifier }}</span>
                  <span v-if="b.position" class="pill stance">{{ b.position }}</span>
                  <span v-if="b.unreadAlerts" class="pill alerts">{{ b.unreadAlerts }} new</span>
                </span>
                <span class="row-title">{{ b.title }}</span>
                <span class="row-foot faint">
                  {{ day(b.lastActionDate) }}
                  <template v-if="b.lastActionText"> · {{ b.lastActionText }}</template>
                </span>
              </span>
            </NuxtLink>
          </li>
        </ul>
      </section>

      <!-- ── The bill ───────────────────────────────────────────────────── -->
      <section class="detail">
        <div v-if="!selectedId" class="pane-card empty-pane">
          <span class="label">No bill selected</span>
          <span class="muted">
            Pick one to see where it stands, how it got there, who put it there, and
            everything we've said about it.
          </span>
        </div>

        <p v-else-if="detailPending && !detail" class="pane-card muted">Loading…</p>

        <div v-else-if="detail" class="pane-card bill">
          <header class="bill-head">
            <div class="bill-ident">
              <SignalDot :signal="detail.signal" :size="9" />
              <span class="ident big">{{ detail.identifier }}</span>
              <span class="signal-label" :style="{ color: signalColor(detail.signal) }">
                {{ SIGNAL_LABEL[detail.signal] }}
              </span>
            </div>
            <h2>{{ detail.title }}</h2>
            <div class="tags">
              <span class="pill">{{ SOURCE_LABEL[detail.jurisdiction] ?? detail.jurisdiction }}</span>
              <span class="pill">{{ statusLabel(detail.status) }}</span>
              <span v-if="detail.billType" class="pill">{{ detail.billType }}</span>
              <span v-if="detail.session" class="pill">{{ detail.session }}</span>
              <NuxtLink
                v-if="detail.committee"
                :to="`/bills?committeeId=${detail.committee.id}`"
                class="pill cmte"
              >{{ detail.committee.name }}</NuxtLink>
            </div>
          </header>

          <p v-if="detail.summary" class="summary">{{ detail.summary }}</p>

          <div class="links">
            <a v-if="detail.sourceUrl" :href="detail.sourceUrl" target="_blank" rel="noopener">
              Source record ↗
            </a>
            <a v-if="detail.fullTextUrl" :href="detail.fullTextUrl" target="_blank" rel="noopener">
              Full text ↗
            </a>
          </div>

          <!-- Sponsors: linked to the CRM where the matcher resolved them, plain text where
               it would not guess (ITLK-7). -->
          <section class="block">
            <div class="label">Sponsors</div>
            <p v-if="!detail.sponsors.length" class="faint small">No sponsors recorded.</p>
            <ul v-else class="sponsors">
              <li v-for="s in detail.sponsors" :key="s.sponsorshipId">
                <NuxtLink v-if="s.officialId" :to="`/officials/${s.officialId}`" class="sponsor linked">
                  <OfficialAvatar :name="s.fullName ?? s.sponsorName" :size="18" />
                  <span class="sponsor-name">{{ s.fullName ?? s.sponsorName }}</span>
                  <span v-if="seat(s)" class="faint small">{{ seat(s) }}</span>
                  <span class="pill">{{ s.sponsorType }}</span>
                </NuxtLink>
                <span v-else class="sponsor unmatched" title="The matcher would not guess at this name">
                  <span class="sponsor-name">{{ s.sponsorName }}</span>
                  <span class="pill">{{ s.sponsorType }}</span>
                  <NuxtLink to="/officials/review" class="pill unresolved">unmatched</NuxtLink>
                </span>
              </li>
            </ul>
          </section>

          <!-- Action timeline: newest at the accent end of the spine (brief §2.10). -->
          <section class="block">
            <div class="label">Action timeline</div>
            <p v-if="!detail.actions.length" class="faint small">No actions recorded.</p>
            <ol v-else class="timeline">
              <li v-for="(a, i) in detail.actions" :key="a.id" :class="{ latest: i === 0 }">
                <span class="node" />
                <div class="event">
                  <div class="event-head">
                    <span class="event-date mono">{{ day(a.actionDate) }}</span>
                    <span class="pill">{{ a.classification }}</span>
                    <span v-if="a.actor" class="faint small">{{ a.actor }}</span>
                  </div>
                  <div class="event-body">{{ a.description }}</div>
                </div>
              </li>
            </ol>
          </section>

          <!-- Letters about this bill (ITLK-10). -->
          <section v-if="detail.letters.length" class="block">
            <div class="label">Letters</div>
            <ul class="letters">
              <li v-for="l in detail.letters" :key="l.id">
                <span class="status" :data-status="l.status">{{ l.status }}</span>
                <span class="letter-subject">{{ l.subject }}</span>
                <span class="pill">{{ l.direction }}</span>
                <span class="faint small mono">{{ day(l.sentDate ?? l.receivedDate) }}</span>
              </li>
            </ul>
            <p class="more">
              <NuxtLink :to="`/letters?billId=${detail.id}`">Open in the ledger →</NuxtLink>
            </p>
          </section>
          <p v-else class="block faint small">
            Nothing written about this one yet.
            <NuxtLink :to="`/letters?billId=${detail.id}`">Log a letter →</NuxtLink>
          </p>

          <!-- ── Track: flow A ends here, so the control does too. ──────── -->
          <footer class="track">
            <template v-if="picking">
              <div class="label">{{ detail.tracked ? 'Change the stance' : 'Take a position' }}</div>
              <div class="stance-row">
                <button
                  v-for="p in TRACKED_POSITIONS"
                  :key="p"
                  :class="stance.position === p ? 'secondary' : ''"
                  @click="stance.position = p"
                >{{ p }}</button>
                <label class="priority">
                  <span class="label">Priority</span>
                  <input v-model="stance.priority" type="number" min="0" max="9" />
                </label>
              </div>
              <input v-model="stance.notes" placeholder="Why does this one matter?" class="notes" />
              <div class="track-actions">
                <button class="primary" :disabled="busy" @click="saveTracking(detail)">
                  {{ detail.tracked ? 'Save' : 'Track it' }}
                </button>
                <button :disabled="busy" @click="picking = false">Cancel</button>
                <button v-if="detail.tracked" class="danger" :disabled="busy" @click="untracking = detail">
                  Untrack
                </button>
              </div>
            </template>

            <template v-else-if="detail.tracked">
              <div class="tracked-state">
                <span class="label">Tracked</span>
                <span class="pill stance">{{ detail.tracked.position }}</span>
                <span v-if="detail.tracked.priority" class="pill">priority {{ detail.tracked.priority }}</span>
                <span class="faint small">The worker watches this one; it cannot move quietly.</span>
                <button @click="openPicker(detail)">Change</button>
              </div>
              <p v-if="detail.tracked.notes" class="tracked-notes">{{ detail.tracked.notes }}</p>
            </template>

            <template v-else>
              <button class="primary" @click="openPicker(detail)">Track this bill</button>
              <span class="faint small">
                Pick a stance and the worker starts watching it for movement.
              </span>
            </template>
          </footer>
        </div>
      </section>
    </div>

    <ConfirmDialog
      v-if="untracking"
      title="Stop tracking this bill?"
      :subject="`${untracking.identifier} — ${untracking.title}`"
      body="Your position, priority and notes are lost, and the worker stops watching it — after which it can move without an alert firing."
      confirm-label="Untrack"
      :busy="busy"
      @confirm="untrack"
      @cancel="untracking = null"
    />
  </main>
</template>

<style scoped>
h1 { margin: 28px 0 0; font-size: 30px; }
.intro { max-width: 66ch; margin: 8px 0 20px; }

.panes {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
  gap: 16px;
  align-items: start;
}

/* --- List ----------------------------------------------------------------- */
.list { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
.filters { display: flex; flex-direction: column; gap: 8px; }
.filters input, .filters select { width: 100%; }
.filter-row { display: flex; gap: 6px; }
.filter-row select { flex: 1; min-width: 0; }
.loading { margin-top: 14px; font-size: 13px; }
.active-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--accdim);
  border: 1px solid var(--accent);
  border-radius: 8px;
}
.active-filter .x {
  margin-left: auto;
  border: none;
  background: none;
  padding: 0 2px;
  color: var(--faint);
  font-size: 14px;
}
.active-filter .x:hover:not(:disabled) { color: var(--ink); border: none; }

.rows { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.rows a {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  color: var(--ink2);
}
.rows a:hover { background: var(--panel2); }
.rows a.on { background: var(--accdim); border-color: var(--accent); }
.rows .dot { margin-top: 6px; }
.row-body { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.row-top { display: flex; align-items: center; gap: 6px; }
.row-title {
  font-size: 13px;
  line-height: 1.35;
  color: var(--ink);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}
.row-foot {
  font-size: 11px;
  font-family: var(--font-mono);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pill.alerts { color: var(--accent); border-color: var(--accent); }
.pill.stance { color: var(--caution); border-color: var(--caution); }

.empty, .empty-pane {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 28px 16px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  margin-top: 12px;
  font-size: 13px;
}

/* --- The bill ------------------------------------------------------------- */
.pane-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px 26px; }
.empty-pane { margin-top: 0; text-align: center; align-items: center; }

.bill-ident { display: flex; align-items: center; gap: 8px; }
.ident.big { font-size: 14px; }
.signal-label {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.bill h2 { margin: 8px 0 10px; font-size: 20px; line-height: 1.3; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.pill.cmte:hover { border-color: var(--accent); color: var(--ink); }
.summary { font-size: 14px; margin: 16px 0 0; }
.links { display: flex; gap: 14px; margin-top: 12px; font-family: var(--font-mono); font-size: 12px; }

.block { margin-top: 24px; border-top: 1px solid var(--linesoft); padding-top: 16px; }
.small { font-size: 12px; }

/* --- Sponsors ------------------------------------------------------------- */
.sponsors { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.sponsor {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--ink2);
}
.sponsor.linked:hover { background: var(--panel2); color: var(--ink); }
.sponsor-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The matcher would not guess at this one — it is a name, not a person, and it says so. */
.sponsor.unmatched { border: 1px dashed var(--line); }
.pill.unresolved { color: var(--caution); border-color: var(--caution); border-style: dashed; }

/* --- Timeline (brief §2.10: newest node at the accent end of the spine) ---- */
.timeline { list-style: none; margin: 12px 0 0; padding: 0 0 0 24px; position: relative; }
.timeline::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: linear-gradient(180deg, var(--accent), var(--line));
  border-radius: 2px;
}
.timeline li { position: relative; padding-bottom: 16px; }
.timeline li:last-child { padding-bottom: 0; }
.node {
  position: absolute;
  left: -24px;
  top: 3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--bg);
  border: 2px solid var(--faint);
}
.timeline li.latest .node { width: 14px; height: 14px; left: -25px; border-color: var(--accent); }
.event-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.event-date { font-size: 12px; color: var(--muted); }
.event-body { font-size: 13px; color: var(--muted); margin-top: 2px; }
.timeline li.latest .event-body { color: var(--ink2); }

/* --- Letters -------------------------------------------------------------- */
.letters { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.letters li {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--panel2);
  border-radius: 5px;
  padding: 7px 9px;
  font-size: 13px;
}
.letter-subject { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border-radius: 4px;
  padding: 2px 6px;
  min-width: 62px;
  text-align: center;
  flex: none;
  color: var(--bg);
  background: var(--faint);
}
.status[data-status='sent'] { background: var(--caution); }
.status[data-status='responded'] { background: var(--go); }
.status[data-status='closed'] { background: var(--muted); }
.more { font-family: var(--font-mono); font-size: 12px; margin: 10px 0 0; }

/* --- Track: bottom-anchored, per the brief's wireframe. -------------------- */
.track {
  margin-top: 24px;
  border-top: 1px solid var(--line);
  padding-top: 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.tracked-state { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tracked-notes { font-size: 13px; margin: 0; color: var(--ink2); }
.stance-row { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
.stance-row button { text-transform: capitalize; }
.priority { display: flex; flex-direction: column; gap: 4px; }
.priority input { width: 72px; }
.notes { width: 100%; }
.track-actions { display: flex; gap: 8px; }
button.danger:hover:not(:disabled) { border-color: var(--stop); color: var(--stop); }

@media (max-width: 900px) {
  .panes { grid-template-columns: 1fr; }
}
</style>
