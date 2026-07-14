<script setup lang="ts">
import { ref } from 'vue'
import {
  SIGNAL_LABEL,
  TRACKED_POSITIONS,
  type AlertChangeType,
  type Signal,
  type TrackedPosition,
} from '@interlock/shared'

/**
 * The dashboard (ITLK-12, brief §6) — "the organizer's morning glance".
 *
 * Three panels, one question: what needs me today? Everything that moved on a bill we're
 * tracking, everything we promised to chase, and what we're carrying.
 *
 * The brief's one metric is "zero missed movements on tracked bills" — v1 works if the
 * organizer never learns of a tracked bill's movement from an outside source before Interlock
 * told them. This screen is where that promise is either kept or broken, so it is the home
 * route, and it opens with the alerts.
 *
 * One fetch, not three: the panels answer one question at one instant, and three round trips
 * would let them disagree about when "today" is.
 */

interface DashAlert {
  id: string
  billId: string
  identifier: string
  title: string
  signal: Signal
  position: TrackedPosition | null
  changeType: AlertChangeType
  payload: Record<string, unknown>
  detectedAt: string
}
interface DashFollowup {
  letterId: string
  subject: string
  direction: string
  channel: string
  status: string
  followupDate: string
  overdue: boolean
  officials: Array<{ id: string; fullName: string }>
}
interface Dashboard {
  alerts: DashAlert[]
  unreadTotal: number
  followups: DashFollowup[]
  tracked: Record<TrackedPosition, number>
  trackedTotal: number
}

const { data, refresh } = await useFetch<Dashboard>('/api/dashboard')

/** The review queue's count rides along — it's a standing debt, not a today thing. */
const { data: review } = await useFetch<{ total: number }>('/api/review-queue', {
  query: { limit: 1 },
})

const busy = ref(false)

/**
 * Opening an alert marks it read, and it leaves the feed. That is the contract of an unread
 * feed: you can't have looked at a thing and still be told to look at it.
 *
 * Marked read *before* navigating, and awaited — a fire-and-forget POST races the route
 * change, and losing it means the alert comes back tomorrow having already been seen.
 */
async function openAlert(alert: DashAlert): Promise<void> {
  busy.value = true
  try {
    await $fetch(`/api/alerts/${alert.id}/read`, { method: 'POST' })
  } finally {
    busy.value = false
  }
  await navigateTo(`/bills/${alert.billId}`)
}

async function markRead(alert: DashAlert): Promise<void> {
  busy.value = true
  try {
    await $fetch(`/api/alerts/${alert.id}/read`, { method: 'POST' })
    await refresh()
  } finally {
    busy.value = false
  }
}

async function markAllRead(): Promise<void> {
  busy.value = true
  try {
    await $fetch('/api/alerts/read-all', { method: 'POST' })
    await refresh()
  } finally {
    busy.value = false
  }
}

async function markFollowupDone(f: DashFollowup): Promise<void> {
  busy.value = true
  try {
    await $fetch(`/api/letters/${f.letterId}`, {
      method: 'PATCH',
      body: { followupDone: true },
    })
    await refresh()
  } finally {
    busy.value = false
  }
}

const POSITION_GLOSS: Record<TrackedPosition, string> = {
  support: 'we want these',
  oppose: "we're fighting these",
  watch: 'keeping an eye',
}

function when(iso: string): string {
  return new Date(iso).toLocaleString()
}
function day(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString()
}
</script>

<template>
  <main>
    <h1>Today</h1>
    <p class="muted intro">
      Everything that moved on a bill we're tracking, and everything we promised to chase.
    </p>

    <!-- ── What moved ─────────────────────────────────────────────────────── -->
    <section class="card">
      <div class="head">
        <h2>Unread alerts</h2>
        <button v-if="data?.unreadTotal" :disabled="busy" @click="markAllRead">
          Mark all read
        </button>
      </div>

      <!-- The explicit all-clear. A tracked bill that hasn't moved is the *good* outcome,
           and the screen has to say so — a blank panel reads as a broken one. -->
      <div v-if="!data?.alerts.length" class="allclear">
        <span class="dot" />
        <div>
          <div class="allclear-head">All clear</div>
          <p class="muted">
            <template v-if="data?.trackedTotal">
              Nothing has moved on the {{ data.trackedTotal }} bill{{ data.trackedTotal === 1 ? '' : 's' }}
              we're tracking. The worker is watching; they can't move quietly.
            </template>
            <template v-else>
              Nothing is being tracked yet.
              <NuxtLink to="/bills">Find a bill and take a position →</NuxtLink>
            </template>
          </p>
        </div>
      </div>

      <ul v-else class="feed">
        <li v-for="a in data.alerts" :key="a.id">
          <SignalDot :signal="a.signal" :size="8" />
          <button class="body" :disabled="busy" @click="openAlert(a)">
            <span class="line">
              <span class="ident">{{ a.identifier }}</span>
              <span class="pill">{{ changeLabel(a.changeType) }}</span>
              <span v-if="a.position" class="pill stance">{{ a.position }}</span>
              <span class="muted sig">{{ SIGNAL_LABEL[a.signal] }}</span>
            </span>
            <span class="title muted">{{ a.title }}</span>
            <span class="what">{{ summarizeAlert(a.changeType, a.payload) }}</span>
            <span class="when faint">{{ when(a.detectedAt) }}</span>
          </button>
          <button :disabled="busy" title="Mark read without opening it" @click="markRead(a)">
            Read
          </button>
        </li>
      </ul>

      <p v-if="data && data.unreadTotal > data.alerts.length" class="muted more">
        Showing {{ data.alerts.length }} of {{ data.unreadTotal }}.
        <NuxtLink to="/alerts">The whole feed →</NuxtLink>
      </p>
    </section>

    <!-- ── What's due ─────────────────────────────────────────────────────── -->
    <section class="card">
      <div class="head">
        <h2>Follow-ups due</h2>
        <NuxtLink v-if="data?.followups.length" to="/letters" class="mono link">The ledger →</NuxtLink>
      </div>

      <p v-if="!data?.followups.length" class="muted empty">
        Nothing to chase today.
      </p>

      <ul v-else class="followups">
        <li v-for="f in data.followups" :key="f.letterId" :class="{ overdue: f.overdue }">
          <span class="due" :class="{ hot: f.overdue }">
            {{ f.overdue ? 'overdue' : 'today' }}
          </span>
          <NuxtLink :to="`/letters?letterId=${f.letterId}`" class="fu-body">
            <span class="fu-subject">{{ f.subject }}</span>
            <span class="fu-meta muted">
              <template v-if="f.officials.length">
                {{ f.officials.map((o) => o.fullName).join(', ') }} ·
              </template>
              {{ f.channel }} · {{ f.status }} · due {{ day(f.followupDate) }}
            </span>
          </NuxtLink>
          <button :disabled="busy" title="Mark the follow-up done" @click="markFollowupDone(f)">
            Done
          </button>
        </li>
      </ul>
    </section>

    <!-- ── What we're carrying ────────────────────────────────────────────── -->
    <section class="card">
      <div class="head">
        <h2>Tracked bills</h2>
        <NuxtLink to="/bills" class="mono link">All bills →</NuxtLink>
      </div>

      <div class="tiles">
        <!-- Every stance renders, including the zeroes: "nothing opposed" is a real answer,
             and a tile that vanishes at zero is one you can't trust to still be there. -->
        <NuxtLink
          v-for="p in TRACKED_POSITIONS"
          :key="p"
          :to="`/bills?position=${p}`"
          class="tile"
          :data-position="p"
        >
          <span class="count">{{ data?.tracked[p] ?? 0 }}</span>
          <span class="stance-name">{{ p }}</span>
          <span class="gloss faint">{{ POSITION_GLOSS[p] }}</span>
        </NuxtLink>
      </div>

      <p v-if="review?.total" class="muted more">
        <NuxtLink to="/officials/review">
          {{ review.total }} sponsor{{ review.total === 1 ? '' : 's' }} awaiting review
        </NuxtLink>
        — the matcher wouldn't guess at these.
      </p>
    </section>
  </main>
</template>

<style scoped>
h1 { margin: 28px 0 0; font-size: 30px; }
.intro { max-width: 66ch; margin: 8px 0 4px; }

.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.head h2 { margin: 0; }
.link { font-size: 12px; }
.more { font-size: 13px; margin: 14px 0 0; }
.empty { font-size: 13px; margin: 0; }

/* --- All clear ------------------------------------------------------------ */
.allclear {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 18px;
  border: 1px dashed var(--line);
  border-radius: 10px;
}
.allclear .dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--go);
  flex: none;
  margin-top: 6px;
  animation: ilpulse 2.4s ease-in-out infinite;
}
@keyframes ilpulse {
  0%, 100% { opacity: 0.5; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.25); }
}
.allclear-head {
  font-family: var(--font-display);
  font-weight: 600;
  color: var(--ink);
  font-size: 16px;
}
.allclear p { margin: 2px 0 0; font-size: 13px; }

/* --- Alerts feed ---------------------------------------------------------- */
.feed { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.feed li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: var(--panel2);
  border-radius: 8px;
}
.feed .dot { margin-top: 6px; }
/* The whole row is the click target — it opens the bill and marks the alert read. */
.feed .body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  font-family: var(--font-body);
  cursor: pointer;
  color: var(--ink2);
}
.feed .body:hover:not(:disabled) { border: none; }
.feed .body:hover:not(:disabled) .ident { color: var(--accent-bright); }
.line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sig { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }
.title { font-size: 13px; }
.what { font-size: 13px; color: var(--ink); }
.when { font-family: var(--font-mono); font-size: 11px; }
.pill.stance { color: var(--caution); border-color: var(--caution); }

/* --- Follow-ups ----------------------------------------------------------- */
.followups { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.followups li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--panel2);
  border: 1px solid transparent;
  border-radius: 8px;
}
.followups li.overdue { border-color: var(--stop); }
.due {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border-radius: 4px;
  padding: 3px 6px;
  min-width: 62px;
  text-align: center;
  flex: none;
  color: var(--bg);
  background: var(--caution);
}
.due.hot { background: var(--stop); }
.fu-body { flex: 1; min-width: 0; display: flex; flex-direction: column; color: var(--ink2); }
.fu-body:hover .fu-subject { color: var(--accent-bright); }
.fu-subject {
  color: var(--ink);
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fu-meta { font-size: 12px; }

/* --- Tracked tiles -------------------------------------------------------- */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; }
.tile {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 16px 18px;
  background: var(--panel2);
  border: 1px solid var(--line);
  /* Categorized by type, not status — the brief's 2px top border. */
  border-top: 2px solid var(--line);
  border-radius: 10px;
  color: var(--ink2);
}
.tile:hover { border-color: var(--accent); }
.tile[data-position='support'] { border-top-color: var(--go); }
.tile[data-position='oppose'] { border-top-color: var(--stop); }
.tile[data-position='watch'] { border-top-color: var(--watch); }
.count {
  font-family: var(--font-display);
  font-size: 30px;
  font-weight: 600;
  color: var(--ink);
  line-height: 1.1;
}
.stance-name {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.gloss { font-size: 12px; }
</style>
