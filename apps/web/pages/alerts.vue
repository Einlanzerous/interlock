<script setup lang="ts">
import { computed, ref } from 'vue'
import { SIGNAL_LABEL, signalColor, type Signal } from '@interlock/shared'

/**
 * The in-app alert feed (ITLK-8) — where "a tracked bill cannot move without
 * an alert firing" becomes visible. Deliberately plain; ITLK-12's dashboard
 * gets the summarized version.
 */

interface AlertRow {
  id: string
  billId: string
  identifier: string
  title: string
  signal: Signal
  position: string | null
  changeType: string
  payload: Record<string, unknown>
  detectedAt: string
  readAt: string | null
  deliveredChannels: string[]
}

const unreadOnly = ref(true)
const { data, refresh, pending } = await useFetch<{ items: AlertRow[]; unreadTotal: number }>(
  '/api/alerts',
  { query: computed(() => ({ unread: unreadOnly.value ? '1' : '0' })) },
)

const busy = ref(false)

async function markRead(alert: AlertRow): Promise<void> {
  await $fetch(`/api/alerts/${alert.id}/read`, { method: 'POST' })
  await refresh()
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

const CHANGE_LABEL: Record<string, string> = {
  new_action: 'New action',
  status_change: 'Status change',
  new_sponsor: 'New sponsor',
  vote: 'Vote',
  hearing: 'Hearing',
}

/** One human line per alert, straight from the differ's payload. */
function summarize(alert: AlertRow): string {
  const p = alert.payload
  if (alert.changeType === 'status_change') {
    return `${p.from} → ${p.to}`
  }
  if (alert.changeType === 'new_sponsor') {
    const sponsors = (p.sponsors ?? []) as Array<{ name: string }>
    return sponsors.map((s) => s.name).join(', ')
  }
  const actions = (p.actions ?? []) as Array<{ date: string; description: string }>
  return actions.map((a) => `${a.date} — ${a.description}`).join(' · ')
}

function when(iso: string): string {
  return new Date(iso).toLocaleString()
}
</script>

<template>
  <main>
    <section class="card">
      <h2>Alerts</h2>
      <div class="toolbar">
        <label class="muted toggle">
          <input v-model="unreadOnly" type="checkbox" /> unread only
        </label>
        <span class="muted">{{ data?.unreadTotal ?? 0 }} unread</span>
        <button :disabled="busy || !(data?.unreadTotal)" @click="markAllRead">Mark all read</button>
      </div>

      <p v-if="pending" class="muted">Loading…</p>
      <p v-else-if="!data?.items.length" class="muted">
        {{ unreadOnly ? 'Nothing unread — tracked bills are quiet.' : 'No alerts yet.' }}
      </p>

      <ul v-else class="feed">
        <li v-for="alert in data.items" :key="alert.id" :class="{ read: alert.readAt }">
          <span class="dot" :style="{ background: signalColor(alert.signal) }" :title="SIGNAL_LABEL[alert.signal]" />
          <div class="body">
            <div class="head">
              <strong>{{ alert.identifier }}</strong>
              <span class="chip">{{ CHANGE_LABEL[alert.changeType] ?? alert.changeType }}</span>
              <span v-if="alert.position" class="chip stance">{{ alert.position }}</span>
              <span v-if="alert.deliveredChannels.includes('email')" class="chip muted-chip">emailed</span>
            </div>
            <div class="title muted">{{ alert.title }}</div>
            <div class="summary">{{ summarize(alert) }}</div>
            <div class="meta muted">{{ when(alert.detectedAt) }}</div>
          </div>
          <button v-if="!alert.readAt" @click="markRead(alert)">Read</button>
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.toolbar .toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.feed { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.feed li {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #0f1216;
}
.feed li.read { opacity: 0.55; }
.dot { width: 12px; height: 12px; border-radius: 50%; flex: none; margin-top: 6px; }
.body { flex: 1; min-width: 0; }
.head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.chip {
  font-size: 0.75rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 1px 8px;
  color: var(--accent);
}
.chip.stance { color: var(--warn); text-transform: capitalize; }
.chip.muted-chip { color: var(--muted); }
.title { font-size: 0.9rem; }
.summary { margin-top: 4px; }
.meta { font-size: 0.8rem; margin-top: 4px; }
</style>
