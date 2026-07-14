<script setup lang="ts">
import { SIGNALS, SIGNAL_LABEL, signalColor } from '@interlock/shared'

const { data: health } = await useFetch('/api/health')
const { data: review } = await useFetch('/api/review-queue', { query: { limit: 1 } })
const { data: alerts } = await useFetch('/api/alerts', { query: { unread: '1', limit: 1 } })
</script>

<template>
  <main>
    <p class="tagline">Signal-grade tracking for city &amp; state legislation.</p>

    <section class="card">
      <h2>Signal legend</h2>
      <ul class="legend">
        <li v-for="signal in SIGNALS" :key="signal">
          <span class="dot" :style="{ background: signalColor(signal) }" />
          {{ SIGNAL_LABEL[signal] }}
        </li>
      </ul>
    </section>

    <section class="card">
      <h2>Alerts</h2>
      <p v-if="alerts?.unreadTotal">
        <NuxtLink to="/alerts" class="link">
          {{ alerts.unreadTotal }} unread alert{{ alerts.unreadTotal === 1 ? '' : 's' }}
        </NuxtLink>
        — tracked bills moved.
      </p>
      <p v-else class="muted">No unread alerts. Tracked bills are quiet.</p>
    </section>

    <section class="card">
      <h2>Officials</h2>
      <p v-if="review?.total">
        <NuxtLink to="/officials/review" class="link">
          {{ review.total }} sponsor{{ review.total === 1 ? '' : 's' }} awaiting review
        </NuxtLink>
        — the matcher wouldn’t guess at these.
      </p>
      <p v-else class="muted">No sponsors awaiting review.</p>
    </section>

    <section class="card">
      <h2>System</h2>
      <p v-if="health?.ok" class="ok">Database reachable.</p>
      <p v-else class="down">
        Database {{ health?.db ?? 'unknown' }}<span v-if="health?.error">: {{ health.error }}</span>
      </p>
    </section>

    <footer class="foot">Scaffold — ITLK-2. Screens land in ITLK-9 through ITLK-12.</footer>
  </main>
</template>

<style scoped>
.tagline { color: var(--muted); margin-top: 12px; }
.legend { list-style: none; padding: 0; margin: 0; display: flex; gap: 20px; flex-wrap: wrap; }
.legend li { display: flex; align-items: center; gap: 8px; }
.dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
.link { color: var(--accent); }
.ok { color: var(--ok); margin: 0; }
.down { color: var(--bad); margin: 0; }
.foot { color: var(--muted); font-size: 0.85rem; margin-top: 32px; }
</style>
