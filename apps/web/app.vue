<script setup lang="ts">
/**
 * The app shell, and the design system every screen borrows from.
 *
 * The tokens, the three-font split and the component grammar below are lifted from the
 * Interlock Design Brief (the `.dc.html` linked on the epic) rather than invented here, so
 * the screens landing in ITLK-9 → ITLK-12 agree with each other by construction instead of
 * by cross-referencing. Two rules from the brief are easy to violate by habit:
 *
 *   - **Mono is for anything a machine chose.** Identifiers (`HB1234`), enum values, and —
 *     less obviously — button and tab labels, which are machine affordances. Space Grotesk
 *     is for names a *human* chose (a person, a bill's title). Plex Sans carries sentences.
 *
 *   - **Depth is layering, never shadow.** `--bg` → `--panel` → `--panel2` plus 1px borders.
 *     There is not one box-shadow in the brief, and there should not be one here.
 */
</script>

<template>
  <div class="shell">
    <header class="masthead">
      <NuxtLink to="/" class="brand">
        <svg width="26" height="26" viewBox="0 0 46 46" fill="none" aria-hidden="true">
          <line x1="2" y1="13" x2="24" y2="23" stroke="#4db6d9" stroke-width="2.4" stroke-linecap="round" />
          <line x1="2" y1="23" x2="24" y2="23" stroke="#4db6d9" stroke-width="2.4" stroke-linecap="round" opacity="0.45" />
          <line x1="2" y1="33" x2="24" y2="23" stroke="#4db6d9" stroke-width="2.4" stroke-linecap="round" />
          <circle cx="33" cy="23" r="9" stroke="#eef1f4" stroke-width="2.4" />
          <circle cx="33" cy="23" r="3" fill="#4db6d9" />
        </svg>
        <span>Interlock</span>
      </NuxtLink>
      <nav>
        <NuxtLink to="/bills">Bills</NuxtLink>
        <NuxtLink to="/officials">Officials</NuxtLink>
        <NuxtLink to="/letters">Letters</NuxtLink>
        <NuxtLink to="/alerts">Alerts</NuxtLink>
      </nav>
    </header>

    <NuxtPage />
  </div>
</template>

<style>
:root {
  /* Palette — verbatim from the brief. */
  --bg: #0d0f12;
  --panel: #14171c;
  --panel2: #191d23;
  --line: #262b33;
  --linesoft: #1c2128;
  --ink: #eef1f4;
  --ink2: #c4cad2;
  --muted: #8a929c;
  --faint: #5b636d;
  --accent: #4db6d9;
  --accent-bright: #7fd0ea;
  --accdim: rgba(77, 182, 217, 0.12);

  /* Signal legend. The token is --go; the label the user reads is "CLEAR". */
  --watch: #6ea8e0;
  --caution: #e0b155;
  --go: #57c88a;
  --stop: #e07a6b;

  /* Pre-brief aliases, kept so ITLK-7/8's screens keep rendering. Prefer the names above. */
  --ok: var(--go);
  --warn: var(--caution);
  --bad: var(--stop);

  --font-display: 'Space Grotesk', system-ui, sans-serif;
  --font-body: 'IBM Plex Sans', system-ui, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, monospace;
}

* { box-sizing: border-box; }
/* The background belongs to the body, not the shell — the shell is 1180px wide and the
   viewport is not, so painting it only on the shell leaves white gutters either side. */
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink2);
}
::selection { background: rgba(77, 182, 217, 0.28); }

.shell {
  min-height: 100vh;
  color: var(--ink2);
  font-family: var(--font-body);
  line-height: 1.6;
  max-width: 1180px;
  margin: 0 auto;
  padding: 32px 40px 100px;
}

h1, h2, h3 { font-family: var(--font-display); color: var(--ink); letter-spacing: -0.01em; }

.masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--linesoft);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ink);
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
  text-decoration: none;
}
.masthead nav { display: flex; gap: 18px; }
.masthead nav a {
  color: var(--muted);
  text-decoration: none;
  font-size: 13.5px;
}
.masthead nav a:hover,
.masthead nav a.router-link-active { color: var(--ink); }

/* --- Card: the base surface. --------------------------------------------- */
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 20px 26px;
  margin-top: 24px;
}

/* --- Micro-label: the brief's most distinctive rule. ---------------------- */
/* Uppercase mono, wide tracking; the *color* carries the meaning (muted = neutral,
   accent = the key idea, caution/stop = a hazard). */
.label {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
}
.card > h2 {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0 0 12px;
}

.muted { color: var(--muted); }
.faint { color: var(--faint); }
.mono { font-family: var(--font-mono); }
/* Identifiers are machine-chosen, so they are mono — O2024-0001, HB1234. */
.ident { font-family: var(--font-mono); color: var(--accent); }

a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-bright); }

/* --- Buttons and tabs: mono labels, per the brief. ------------------------ */
button {
  font-family: var(--font-mono);
  font-size: 13px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  padding: 8px 14px;
  cursor: pointer;
}
button:hover:not(:disabled) { color: var(--ink); border-color: var(--accent); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg);
  font-weight: 600;
}
button.primary:hover:not(:disabled) {
  background: var(--accent-bright);
  border-color: var(--accent-bright);
  color: var(--bg);
}
/* Secondary == the brief's *active tab* style. */
button.secondary {
  background: var(--panel2);
  border-color: var(--accent);
  color: var(--ink);
}

/* --- Form controls: derived from the panel grammar. ----------------------- */
input, select, textarea {
  font-family: var(--font-body);
  font-size: 14px;
  background: var(--panel2);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 12px;
}
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
input::placeholder, textarea::placeholder { color: var(--faint); }
textarea { line-height: 1.6; resize: vertical; }

/* --- Tag pill: outline-only, mono, no fill. ------------------------------- */
.pill {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 8px;
  white-space: nowrap;
}
/* "Not from a feed" — the brief's idiom for it is a dashed border. */
.pill.manual { border-style: dashed; color: var(--faint); }

.error {
  background: #2a1614;
  border: 1px solid var(--stop);
  color: var(--stop);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 14px;
}
</style>
