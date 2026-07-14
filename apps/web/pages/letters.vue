<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  LETTER_CHANNELS,
  LETTER_DIRECTIONS,
  LETTER_OFFICIAL_ROLES,
  LETTER_STATUSES,
  type LetterChannel,
  type LetterDirection,
  type LetterOfficialRole,
  type LetterStatus,
  type Signal,
} from '@interlock/shared'

/**
 * The letters ledger (ITLK-10, brief §6 / user flow B).
 *
 * Every letter, call, email and web-form submission — sent or received — logged once and
 * cross-referenced to the bills and officials it concerns. Full-width list, not two panes:
 * the ledger is something you scan, and composing happens in a drawer over it.
 *
 * A phone call is a first-class row here. The compose form asks for direction and channel
 * before anything else, and nothing downstream of that is email-shaped: a received call
 * with notes and no subject line... well, it needs a subject, because a ledger of untitled
 * rows is unscannable — but it needs nothing else.
 *
 * Status is a `<select>` on the row rather than a "next step" button, so all four of
 * draft → sent → responded → closed are one click from the ledger, including going back.
 */

interface LedgerOfficial {
  id: string
  fullName: string
  role: LetterOfficialRole
}
interface LedgerBill {
  id: string
  identifier: string
  signal: Signal
}
interface LetterRow {
  id: string
  direction: LetterDirection
  channel: LetterChannel
  status: LetterStatus
  subject: string
  body: string | null
  sentDate: string | null
  receivedDate: string | null
  followupDate: string | null
  followupDone: boolean
  officials: LedgerOfficial[]
  bills: LedgerBill[]
}
interface OfficialSummary {
  id: string
  fullName: string
  role: string
  ward: number | null
  district: string | null
}
interface BillSummary {
  id: string
  identifier: string
  title: string
  signal: Signal
}

const route = useRoute()

/* ── Filters ────────────────────────────────────────────────────────────── */
/* Kept in the URL, so "everything we've said to Ald. Lopez" and "everything about HB1234"
   are links — which is what the CRM (ITLK-9) and the bill detail (ITLK-11) point at. */

const filters = reactive({
  officialId: (route.query.officialId as string) ?? '',
  billId: (route.query.billId as string) ?? '',
  direction: (route.query.direction as string) ?? '',
  status: (route.query.status as string) ?? '',
})

const { data: roster } = await useFetch<OfficialSummary[]>('/api/officials', {
  query: { active: 'all', limit: 500 },
})

const { data: ledger, refresh } = await useFetch<{
  items: LetterRow[]
  total: number
  followupsDue: number
}>('/api/letters', {
  query: computed(() => ({
    officialId: filters.officialId || undefined,
    billId: filters.billId || undefined,
    direction: filters.direction || undefined,
    status: filters.status || undefined,
  })),
})

/** The bill filter is a typeahead, not a select — there are thousands of bills. */
const billFilter = useTypeahead<BillSummary>('/api/bills')
const billFilterLabel = ref('')

function applyBillFilter(bill: BillSummary): void {
  filters.billId = bill.id
  billFilterLabel.value = bill.identifier
  billFilter.clear()
}
function clearFilters(): void {
  filters.officialId = ''
  filters.billId = ''
  filters.direction = ''
  filters.status = ''
  billFilterLabel.value = ''
}
const filtered = computed(
  () => !!(filters.officialId || filters.billId || filters.direction || filters.status),
)

/* ── Compose / edit drawer ──────────────────────────────────────────────── */

type Draft = {
  id: string | null
  direction: LetterDirection
  channel: LetterChannel
  status: LetterStatus
  subject: string
  body: string
  sentDate: string
  receivedDate: string
  followupDate: string
  officials: Array<{ officialId: string; fullName: string; role: LetterOfficialRole }>
  bills: Array<{ id: string; identifier: string }>
}

const blank = (): Draft => ({
  id: null,
  direction: 'sent',
  channel: 'email',
  status: 'draft',
  subject: '',
  body: '',
  sentDate: '',
  receivedDate: '',
  followupDate: '',
  officials: [],
  bills: [],
})

const open = ref(false)
const draft = ref<Draft>(blank())
const busy = ref(false)
const error = ref<string | null>(null)

/**
 * The drawer does double duty: reading a letter and writing one.
 *
 * Reading needs to exist as its own thing. The body of a letter *is* the record — for a
 * logged phone call it is the entire content — and reaching it only through the edit form
 * means you open a form to read, which invites changing something by accident and makes the
 * commonest action (look at what we said) the one that feels dangerous.
 */
const mode = ref<'view' | 'edit'>('edit')
const viewing = ref<LetterRow | null>(null)

const officialPick = useTypeahead<OfficialSummary>('/api/officials', { active: 'all' })
const billPick = useTypeahead<BillSummary>('/api/bills')

/**
 * `/letters?letterId=…` opens that letter straight to the read view.
 *
 * The dashboard's follow-up panel (ITLK-12) needs to point at *one letter* — "chase this
 * one" is useless if it only gets you to a list you then have to search. A letter isn't a
 * route of its own (the ledger is the surface, and the drawer is a layer on it), so the id
 * is a query param that the ledger opens on arrival.
 *
 * Done on mount rather than watched: the drawer is a transient layer, and re-opening it every
 * time the URL happened to still carry the param would fight the user closing it.
 */
onMounted(() => {
  const wanted = route.query.letterId as string | undefined
  if (!wanted) return
  const letter = ledger.value?.items.find((l) => l.id === wanted)
  if (letter) view(letter)
})

function compose(): void {
  draft.value = blank()
  error.value = null
  mode.value = 'edit'
  open.value = true
}

function view(letter: LetterRow): void {
  viewing.value = letter
  error.value = null
  mode.value = 'view'
  open.value = true
}

function editFromView(): void {
  if (viewing.value) edit(viewing.value)
}

function edit(letter: LetterRow): void {
  mode.value = 'edit'
  draft.value = {
    id: letter.id,
    direction: letter.direction,
    channel: letter.channel,
    status: letter.status,
    subject: letter.subject,
    body: letter.body ?? '',
    sentDate: letter.sentDate ?? '',
    receivedDate: letter.receivedDate ?? '',
    followupDate: letter.followupDate ?? '',
    officials: letter.officials.map((o) => ({
      officialId: o.id,
      fullName: o.fullName,
      role: o.role,
    })),
    bills: letter.bills.map((b) => ({ id: b.id, identifier: b.identifier })),
  }
  error.value = null
  open.value = true
}

function addOfficial(o: OfficialSummary): void {
  if (!draft.value.officials.some((x) => x.officialId === o.id)) {
    draft.value.officials.push({ officialId: o.id, fullName: o.fullName, role: 'recipient' })
  }
  officialPick.clear()
}
function addBill(b: BillSummary): void {
  if (!draft.value.bills.some((x) => x.id === b.id)) {
    draft.value.bills.push({ id: b.id, identifier: b.identifier })
  }
  billPick.clear()
}

async function save(): Promise<void> {
  const d = draft.value
  busy.value = true
  error.value = null
  const body = {
    direction: d.direction,
    channel: d.channel,
    status: d.status,
    subject: d.subject,
    body: d.body,
    sentDate: d.sentDate || null,
    receivedDate: d.receivedDate || null,
    followupDate: d.followupDate || null,
    officials: d.officials.map((o) => ({ officialId: o.officialId, role: o.role })),
    billIds: d.bills.map((b) => b.id),
  }
  try {
    if (d.id) await $fetch(`/api/letters/${d.id}`, { method: 'PATCH', body })
    else await $fetch('/api/letters', { method: 'POST', body })
    open.value = false
    await refresh()
  } catch (err: unknown) {
    error.value = messageOf(err)
  } finally {
    busy.value = false
  }
}

/* ── Row actions ────────────────────────────────────────────────────────── */

async function setStatus(letter: LetterRow, status: string): Promise<void> {
  await patch(letter.id, { status })
}
async function markFollowupDone(letter: LetterRow): Promise<void> {
  await patch(letter.id, { followupDone: true })
}
async function patch(id: string, body: Record<string, unknown>): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await $fetch(`/api/letters/${id}`, { method: 'PATCH', body })
    await refresh()
  } catch (err: unknown) {
    error.value = messageOf(err)
  } finally {
    busy.value = false
  }
}
/** The letter the delete dialog is asking about. Null = no dialog. */
const deleting = ref<LetterRow | null>(null)

async function remove(): Promise<void> {
  const letter = deleting.value
  if (!letter) return
  busy.value = true
  error.value = null
  try {
    await $fetch(`/api/letters/${letter.id}`, { method: 'DELETE' })
    deleting.value = null
    // If the deleted letter was open in the drawer, that drawer is now showing a row that
    // no longer exists. Close it rather than leave a ghost on screen.
    if (viewing.value?.id === letter.id || draft.value.id === letter.id) open.value = false
    await refresh()
  } catch (err: unknown) {
    error.value = messageOf(err)
    deleting.value = null
  } finally {
    busy.value = false
  }
}

function messageOf(err: unknown): string {
  const data = (err as { data?: { statusMessage?: string } })?.data
  return data?.statusMessage ?? (err instanceof Error ? err.message : String(err))
}

/* ── Presentation ───────────────────────────────────────────────────────── */

const CHANNEL_LABEL: Record<string, string> = {
  email: 'email',
  mail: 'mail',
  web_form: 'web form',
  phone: 'phone',
  in_person: 'in person',
}

const today = new Date().toISOString().slice(0, 10)
/** A follow-up that has come due and hasn't been done is the ledger's one hazard. */
function overdue(letter: LetterRow): boolean {
  return !!letter.followupDate && !letter.followupDone && letter.followupDate <= today
}
function day(iso: string | null): string {
  return iso ? new Date(`${iso}T00:00:00`).toLocaleDateString() : '—'
}
function seat(o: OfficialSummary): string {
  if (o.ward != null) return `Ward ${o.ward}`
  return o.district || o.role
}
</script>

<template>
  <main>
    <div class="head">
      <h1>Letters</h1>
      <span v-if="ledger?.followupsDue" class="due-flag">
        {{ ledger.followupsDue }} follow-up{{ ledger.followupsDue === 1 ? '' : 's' }} due
      </span>
    </div>
    <p class="muted intro">
      Every letter, call, email and web-form submission — sent or received — logged once and
      tied to the bills and officials it concerns.
    </p>

    <p v-if="error" class="error">{{ error }}</p>

    <!-- Toolbar: filters + the one primary action. -->
    <div class="toolbar">
      <select v-model="filters.officialId">
        <option value="">Any official</option>
        <option v-for="o in roster ?? []" :key="o.id" :value="o.id">
          {{ o.fullName }} · {{ seat(o) }}
        </option>
      </select>

      <div class="bill-filter">
        <span v-if="filters.billId" class="pill bill-chip">
          {{ billFilterLabel || 'bill' }}
          <button class="x" @click="filters.billId = ''; billFilterLabel = ''">×</button>
        </span>
        <template v-else>
          <input v-model="billFilter.q.value" type="search" placeholder="Any bill…" />
          <ul v-if="billFilter.results.value.length" class="suggestions">
            <li v-for="b in billFilter.results.value" :key="b.id">
              <button @click="applyBillFilter(b)">
                <SignalDot :signal="b.signal" />
                <span class="ident">{{ b.identifier }}</span>
                <span class="sug-title">{{ b.title }}</span>
              </button>
            </li>
          </ul>
        </template>
      </div>

      <select v-model="filters.direction">
        <option value="">Sent &amp; received</option>
        <option v-for="d in LETTER_DIRECTIONS" :key="d" :value="d">{{ d }}</option>
      </select>

      <select v-model="filters.status">
        <option value="">Any status</option>
        <option v-for="s in LETTER_STATUSES" :key="s" :value="s">{{ s }}</option>
      </select>

      <button v-if="filtered" @click="clearFilters">Clear</button>
      <button class="primary compose" @click="compose">Compose</button>
    </div>

    <!-- Ledger -->
    <p v-if="!ledger?.items.length" class="empty">
      <span class="label">Nothing logged</span>
      <span class="muted">
        {{ filtered ? 'No letter matches these filters.' : 'Compose the first one — a call counts.' }}
      </span>
    </p>

    <ul v-else class="ledger">
      <li v-for="l in ledger.items" :key="l.id" :class="{ overdue: overdue(l) }">
        <span class="status" :data-status="l.status">{{ l.status }}</span>

        <div class="row-body">
          <div class="row-top">
            <!-- The subject opens the letter to *read*. Editing is a separate, deliberate act. -->
            <button class="subject" :title="l.body ? 'Read this one' : 'Open'" @click="view(l)">
              {{ l.subject }}
            </button>
            <span class="pill">{{ l.direction }}</span>
            <span class="pill">{{ CHANNEL_LABEL[l.channel] ?? l.channel }}</span>
          </div>
          <div class="row-links">
            <NuxtLink
              v-for="o in l.officials"
              :key="o.id"
              :to="`/officials/${o.id}`"
              class="pill who"
            >{{ o.fullName }} · {{ o.role }}</NuxtLink>
            <NuxtLink v-for="b in l.bills" :key="b.id" :to="`/bills/${b.id}`" class="pill bill">
              <SignalDot :signal="b.signal" />
              <span class="ident">{{ b.identifier }}</span>
            </NuxtLink>
            <span v-if="!l.officials.length && !l.bills.length" class="faint unlinked">
              linked to nobody
            </span>
          </div>
        </div>

        <div class="row-when">
          <span class="when faint">{{ day(l.sentDate ?? l.receivedDate) }}</span>
          <span v-if="l.followupDate && !l.followupDone" class="followup" :class="{ hot: overdue(l) }">
            follow up {{ day(l.followupDate) }}
            <button class="x" title="Mark the follow-up done" @click="markFollowupDone(l)">✓</button>
          </span>
        </div>

        <div class="row-actions">
          <!-- `:selected` on the option, not `:value` on the select: binding the select's
               value sets a DOM property that is applied before v-for has rendered the
               options, so every row would silently show the first status instead of its
               own. (It did.) -->
          <select :disabled="busy" @change="setStatus(l, ($event.target as HTMLSelectElement).value)">
            <option v-for="s in LETTER_STATUSES" :key="s" :value="s" :selected="s === l.status">
              {{ s }}
            </option>
          </select>
          <button :disabled="busy" @click="edit(l)">Edit</button>
          <button :disabled="busy" class="danger" title="Delete" @click="deleting = l">×</button>
        </div>
      </li>
    </ul>

    <!-- ── Drawer: read a letter, or write one ──────────────────────────── -->
    <div v-if="open" class="scrim" @click.self="open = false">
      <!-- Reading. The body is the record — for a logged call it is the whole record — so it
           gets a surface of its own rather than being reachable only through the edit form. -->
      <aside v-if="mode === 'view' && viewing" class="drawer">
        <div class="drawer-head">
          <span class="label">Letter</span>
          <button class="x" @click="open = false">×</button>
        </div>

        <h2 class="read-subject">{{ viewing.subject }}</h2>

        <div class="read-tags">
          <span class="status" :data-status="viewing.status">{{ viewing.status }}</span>
          <span class="pill">{{ viewing.direction }}</span>
          <span class="pill">{{ CHANNEL_LABEL[viewing.channel] ?? viewing.channel }}</span>
        </div>

        <dl class="read-meta">
          <template v-if="viewing.officials.length">
            <dt class="label">{{ viewing.direction === 'sent' ? 'To' : 'From' }}</dt>
            <dd>
              <NuxtLink
                v-for="o in viewing.officials"
                :key="o.id"
                :to="`/officials/${o.id}`"
                class="pill who"
              >{{ o.fullName }} · {{ o.role }}</NuxtLink>
            </dd>
          </template>
          <template v-if="viewing.bills.length">
            <dt class="label">About</dt>
            <dd>
              <NuxtLink v-for="b in viewing.bills" :key="b.id" :to="`/bills/${b.id}`" class="pill bill">
                <SignalDot :signal="b.signal" />
                <span class="ident">{{ b.identifier }}</span>
              </NuxtLink>
            </dd>
          </template>
          <template v-if="viewing.sentDate">
            <dt class="label">Sent</dt><dd class="mono">{{ day(viewing.sentDate) }}</dd>
          </template>
          <template v-if="viewing.receivedDate">
            <dt class="label">Received</dt><dd class="mono">{{ day(viewing.receivedDate) }}</dd>
          </template>
          <template v-if="viewing.followupDate">
            <dt class="label">Follow up</dt>
            <dd class="mono" :class="{ hot: overdue(viewing) }">
              {{ day(viewing.followupDate) }}
              <span v-if="viewing.followupDone" class="faint">· done</span>
              <span v-else-if="overdue(viewing)">· overdue</span>
            </dd>
          </template>
        </dl>

        <div class="read-body">
          <div class="label">
            {{ viewing.channel === 'phone' || viewing.channel === 'in_person' ? 'Notes' : 'Body' }}
          </div>
          <p v-if="viewing.body" class="read-text">{{ viewing.body }}</p>
          <p v-else class="faint read-text">
            Nothing written down — only the fact that this happened.
          </p>
        </div>

        <div class="drawer-actions">
          <button class="primary" @click="editFromView">Edit</button>
          <button @click="open = false">Close</button>
        </div>
      </aside>

      <!-- Writing. -->
      <aside v-else class="drawer">
        <div class="drawer-head">
          <span class="label">{{ draft.id ? 'Edit letter' : 'Log a letter' }}</span>
          <button class="x" @click="open = false">×</button>
        </div>

        <!-- Flow B, in the brief's order: direction/channel first, because a phone call
             and an email are not the same shape and everything below follows from it. -->
        <div class="pair">
          <label><span class="label">Direction</span>
            <select v-model="draft.direction">
              <option v-for="d in LETTER_DIRECTIONS" :key="d" :value="d">{{ d }}</option>
            </select></label>
          <label><span class="label">Channel</span>
            <select v-model="draft.channel">
              <option v-for="c in LETTER_CHANNELS" :key="c" :value="c">
                {{ CHANNEL_LABEL[c] ?? c }}
              </option>
            </select></label>
        </div>

        <label class="field"><span class="label">Subject</span>
          <input v-model="draft.subject" placeholder="Please support HB1234" /></label>

        <label class="field">
          <span class="label">
            {{ draft.channel === 'phone' || draft.channel === 'in_person' ? 'Notes' : 'Body' }}
          </span>
          <textarea
            v-model="draft.body"
            rows="5"
            :placeholder="draft.channel === 'phone' || draft.channel === 'in_person'
              ? 'What was said.'
              : 'Draft text.'"
          />
        </label>

        <!-- 2. Attach official(s) — typeahead over the CRM. -->
        <div class="field">
          <span class="label">Officials</span>
          <div class="chips">
            <span v-for="(o, i) in draft.officials" :key="o.officialId" class="pill who">
              {{ o.fullName }}
              <select v-model="o.role" class="role">
                <option v-for="r in LETTER_OFFICIAL_ROLES" :key="r" :value="r">{{ r }}</option>
              </select>
              <button class="x" @click="draft.officials.splice(i, 1)">×</button>
            </span>
          </div>
          <div class="pick">
            <input v-model="officialPick.q.value" type="search" placeholder="Search the CRM…" />
            <ul v-if="officialPick.results.value.length" class="suggestions">
              <li v-for="o in officialPick.results.value" :key="o.id">
                <button @click="addOfficial(o)">
                  <OfficialAvatar :name="o.fullName" :size="18" />
                  <span class="sug-title">{{ o.fullName }}</span>
                  <span class="faint">{{ seat(o) }}</span>
                </button>
              </li>
            </ul>
          </div>
        </div>

        <!-- 3. Attach bill(s) it concerns. -->
        <div class="field">
          <span class="label">Bills</span>
          <div class="chips">
            <span v-for="(b, i) in draft.bills" :key="b.id" class="pill bill">
              <span class="ident">{{ b.identifier }}</span>
              <button class="x" @click="draft.bills.splice(i, 1)">×</button>
            </span>
          </div>
          <div class="pick">
            <input v-model="billPick.q.value" type="search" placeholder="Search bills…" />
            <ul v-if="billPick.results.value.length" class="suggestions">
              <li v-for="b in billPick.results.value" :key="b.id">
                <button @click="addBill(b)">
                  <SignalDot :signal="b.signal" />
                  <span class="ident">{{ b.identifier }}</span>
                  <span class="sug-title">{{ b.title }}</span>
                </button>
              </li>
            </ul>
          </div>
        </div>

        <!-- 4. Status + follow-up → shows on the dashboard when due. -->
        <div class="pair">
          <label><span class="label">Status</span>
            <select v-model="draft.status">
              <option v-for="s in LETTER_STATUSES" :key="s" :value="s">{{ s }}</option>
            </select></label>
          <label><span class="label">Follow up on</span>
            <input v-model="draft.followupDate" type="date" /></label>
        </div>

        <div class="pair">
          <label><span class="label">Sent</span><input v-model="draft.sentDate" type="date" /></label>
          <label><span class="label">Received</span><input v-model="draft.receivedDate" type="date" /></label>
        </div>
        <p class="faint hint">
          Leave the date blank and moving this off <em>draft</em> stamps today.
        </p>

        <div class="drawer-actions">
          <button class="primary" :disabled="busy || !draft.subject.trim()" @click="save">
            {{ draft.id ? 'Save' : 'Log it' }}
          </button>
          <button :disabled="busy" @click="open = false">Cancel</button>
        </div>
      </aside>
    </div>

    <!-- Deleting. Its own surface, above the drawer, because it is the one irreversible
         thing on this screen. -->
    <ConfirmDialog
      v-if="deleting"
      title="Delete this letter?"
      :subject="deleting.subject"
      body="It disappears from the ledger, from every official's correspondence tab, and from the bills it was linked to."
      confirm-label="Delete"
      :busy="busy"
      @confirm="remove"
      @cancel="deleting = null"
    />
  </main>
</template>

<style scoped>
.head { display: flex; align-items: baseline; gap: 14px; margin-top: 28px; }
h1 { margin: 0; font-size: 30px; }
.due-flag {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--stop);
  border: 1px solid var(--stop);
  border-radius: 6px;
  padding: 2px 8px;
}
.intro { max-width: 66ch; margin: 8px 0 20px; }

/* --- Toolbar -------------------------------------------------------------- */
.toolbar { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; }
.toolbar > select { min-width: 150px; }
.compose { margin-left: auto; }
.bill-filter { position: relative; min-width: 180px; }
.bill-filter input { width: 100%; }
.bill-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px; }

/* --- Ledger --------------------------------------------------------------- */
.ledger { list-style: none; margin: 20px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ledger li {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--panel2);
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 10px 12px;
}
.ledger li.overdue { border-color: var(--stop); }

/* The one place in the app a signal colour is a solid fill (brief §6). */
.status {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border-radius: 4px;
  padding: 3px 6px;
  min-width: 68px;
  text-align: center;
  flex: none;
  color: var(--bg);
  background: var(--faint);
}
.status[data-status='sent'] { background: var(--caution); }
.status[data-status='responded'] { background: var(--go); }
.status[data-status='closed'] { background: var(--muted); }

.row-body { flex: 1; min-width: 0; }
.row-top { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
/* A button, because it opens the letter — but it is the row's title, so it reads as prose
   and not as a control (the global button style is mono, bordered and boxed). */
.subject {
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 14px;
  background: none;
  border: none;
  padding: 0;
  text-align: left;
  cursor: pointer;
}
.subject:hover:not(:disabled) { color: var(--accent-bright); border: none; }
.row-links { display: flex; gap: 6px; margin-top: 5px; flex-wrap: wrap; align-items: center; }
.pill.who:hover { border-color: var(--accent); color: var(--ink); }
.pill.bill { display: inline-flex; align-items: center; gap: 6px; }
a.pill.bill:hover { border-color: var(--accent); }
.unlinked { font-size: 12px; font-family: var(--font-mono); }

.row-when { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: none; }
.when { font-family: var(--font-mono); font-size: 12px; }
.followup {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.followup.hot { color: var(--stop); }

.row-actions { display: flex; gap: 6px; align-items: center; flex: none; }
.row-actions select { font-family: var(--font-mono); font-size: 12px; padding: 5px 8px; }
button.danger:hover:not(:disabled) { border-color: var(--stop); color: var(--stop); }
button.x {
  border: none;
  background: none;
  padding: 0 2px;
  color: var(--faint);
  font-size: 13px;
  line-height: 1;
}
button.x:hover:not(:disabled) { color: var(--ink); border: none; }

.empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 36px 16px;
  border: 1px dashed var(--line);
  border-radius: 12px;
  margin-top: 20px;
  text-align: center;
  align-items: center;
  font-size: 13px;
}

/* --- Typeahead ------------------------------------------------------------ */
.pick { position: relative; }
.pick input { width: 100%; }
.suggestions {
  position: absolute;
  z-index: 5;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  list-style: none;
  margin: 0;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--accent);
  border-radius: 8px;
  max-height: 260px;
  overflow-y: auto;
}
.suggestions button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  border: none;
  background: none;
  padding: 7px 8px;
  border-radius: 6px;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--ink2);
}
.suggestions button:hover { background: var(--panel2); color: var(--ink); border: none; }
.sug-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* --- Drawer --------------------------------------------------------------- */
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(8, 10, 13, 0.6);
  display: flex;
  justify-content: flex-end;
  z-index: 10;
}
.drawer {
  /* Half the viewport, floored so it stays usable on a laptop and capped so the body text
     doesn't run to an unreadable line length on a wide monitor. */
  width: min(max(50vw, 520px), 100%);
  max-width: 860px;
  height: 100%;
  overflow-y: auto;
  background: var(--panel);
  border-left: 1px solid var(--line);
  padding: 24px 30px 40px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.drawer-head { display: flex; align-items: center; justify-content: space-between; }
.drawer-head .x { font-size: 20px; }

/* --- Reading a letter ----------------------------------------------------- */
.read-subject { margin: 4px 0 0; font-size: 20px; line-height: 1.3; }
.read-tags { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.read-meta {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 8px 14px;
  margin: 6px 0 0;
  font-size: 14px;
}
.read-meta dt { padding-top: 3px; }
.read-meta dd { margin: 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.read-meta .hot { color: var(--stop); }
.read-body { margin-top: 8px; border-top: 1px solid var(--linesoft); padding-top: 16px; }
/* pre-wrap: a letter's paragraphs and a call's scribbled line breaks are content. */
.read-text {
  margin: 8px 0 0;
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.pair label, .field { display: flex; flex-direction: column; gap: 4px; }
.field input, .field textarea, .pair input, .pair select { width: 100%; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chips .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; }
.chips .role {
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--bg);
}
.hint { font-size: 12px; margin: -6px 0 0; }
.drawer-actions { display: flex; gap: 8px; margin-top: 8px; }

@media (max-width: 900px) {
  .ledger li { flex-wrap: wrap; }
  .row-when, .row-actions { margin-left: 46px; }
}
</style>
