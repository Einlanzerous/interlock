<script setup lang="ts">
import { SIGNALS, SIGNAL_LABEL, signalColor } from '@interlock/shared'

const { data: health } = await useFetch('/api/health')
</script>

<template>
  <main class="shell">
    <header class="masthead">
      <h1>Interlock</h1>
      <p class="tagline">Signal-grade tracking for city &amp; state legislation.</p>
    </header>

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
      <h2>System</h2>
      <p v-if="health?.ok" class="ok">Database reachable.</p>
      <p v-else class="down">
        Database {{ health?.db ?? 'unknown' }}<span v-if="health?.error">: {{ health.error }}</span>
      </p>
    </section>

    <footer class="foot">Scaffold — ITLK-2. Screens land in ITLK-9 through ITLK-12.</footer>
  </main>
</template>

<style>
:root {
  --bg: #0d0f12;
  --panel: #14171c;
  --line: #262b33;
  --ink: #eef1f4;
  --muted: #8a929c;
  --accent: #4db6d9;
}
* { box-sizing: border-box; }
body { margin: 0; }
.shell {
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  font-family: system-ui, sans-serif;
  line-height: 1.6;
  max-width: 720px;
  margin: 0 auto;
  padding: 64px 24px;
}
.masthead h1 { margin: 0; color: var(--accent); letter-spacing: -0.02em; }
.tagline { color: var(--muted); margin-top: 4px; }
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 20px 24px;
  margin-top: 24px;
}
.card h2 { margin: 0 0 12px; font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.legend { list-style: none; padding: 0; margin: 0; display: flex; gap: 20px; flex-wrap: wrap; }
.legend li { display: flex; align-items: center; gap: 8px; }
.dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
.ok { color: #57c88a; margin: 0; }
.down { color: #e07a6b; margin: 0; }
.foot { color: var(--muted); font-size: 0.85rem; margin-top: 32px; }
</style>
