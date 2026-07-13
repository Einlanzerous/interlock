<script setup lang="ts">
/**
 * The app shell. Screens live in `pages/` from ITLK-7 on — the routes themselves land in
 * ITLK-9 (Officials) through ITLK-12 (Dashboard); this just gives them somewhere to hang.
 */
</script>

<template>
  <div class="shell">
    <header class="masthead">
      <NuxtLink to="/" class="brand">Interlock</NuxtLink>
      <nav>
        <NuxtLink to="/officials/review">Review queue</NuxtLink>
      </nav>
    </header>

    <NuxtPage />
  </div>
</template>

<style>
:root {
  --bg: #0d0f12;
  --panel: #14171c;
  --line: #262b33;
  --ink: #eef1f4;
  --muted: #8a929c;
  --accent: #4db6d9;
  --ok: #57c88a;
  --warn: #e0b76b;
  --bad: #e07a6b;
}
* { box-sizing: border-box; }
body { margin: 0; }
.shell {
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  font-family: system-ui, sans-serif;
  line-height: 1.6;
  max-width: 940px;
  margin: 0 auto;
  padding: 40px 24px 64px;
}
.masthead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line);
}
.brand {
  color: var(--accent);
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  text-decoration: none;
}
.masthead nav a {
  color: var(--muted);
  text-decoration: none;
  font-size: 0.9rem;
}
.masthead nav a:hover,
.masthead nav a.router-link-active { color: var(--ink); }

.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 20px 24px;
  margin-top: 24px;
}
.card h2 {
  margin: 0 0 12px;
  font-size: 0.95rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}
.muted { color: var(--muted); }
button {
  font: inherit;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: #1d2229;
  color: var(--ink);
  padding: 6px 12px;
  cursor: pointer;
}
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button.primary { background: var(--accent); border-color: var(--accent); color: #08121a; font-weight: 600; }
input, select {
  font: inherit;
  background: #0f1216;
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px 10px;
}
</style>
