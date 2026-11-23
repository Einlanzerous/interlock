import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * The release-please version, read from `.release-please-manifest.json` at build time and
 * frozen into the bundle. release-please (release-type: simple) bumps that manifest and
 * nothing else — package.json stays 0.0.0 — so it is the single source of truth for "what
 * version are we on". The image is rebuilt from the bumped commit on every release, so the
 * baked value is always the version the running container actually is. Falls back to 'dev'
 * for a working tree / any read failure.
 */
function releaseVersion(): string {
  const candidates = [
    new URL('../../.release-please-manifest.json', import.meta.url),
    new URL('.release-please-manifest.json', `file://${process.cwd()}/`),
  ]
  for (const url of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as Record<string, string>
      if (manifest['.']) return manifest['.']
    } catch {
      // try the next candidate
    }
  }
  return 'dev'
}

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },
  // Workspace packages are published as TypeScript source, so Vite must transpile them.
  build: { transpile: ['@interlock/shared', '@interlock/db'] },
  runtimeConfig: {
    databaseUrl: process.env.DATABASE_URL ?? '',
    // Exposed to the client so the masthead can show it.
    public: {
      version: releaseVersion(),
    },
  },
  devServer: {
    port: Number(process.env.WEB_PORT ?? 3000),
  },
  // The brief's three-font system, self-hosted (no render-blocking third party, nothing
  // leaks, works on an offline LAN): Space Grotesk names things a human chose, IBM Plex Sans
  // carries prose, IBM Plex Mono carries anything a machine chose.
  css: [
    '@fontsource-variable/space-grotesk',
    '@fontsource/ibm-plex-sans/400.css',
    '@fontsource/ibm-plex-sans/500.css',
    '@fontsource/ibm-plex-sans/600.css',
    '@fontsource/ibm-plex-mono/400.css',
    '@fontsource/ibm-plex-mono/500.css',
    '@fontsource/ibm-plex-mono/600.css',
  ],
  vite: {
    build: {
      // Firefox is the primary browser: Baseline Widely available plus Firefox 160 as the
      // floor. Anything newer is progressive enhancement.
      target: ['es2022', 'firefox160', 'chrome120', 'safari17'],
    },
    server: {
      /**
       * Vite refuses any request whose `Host` header it doesn't recognize — DNS-rebinding
       * protection, and worth keeping. But it means that the moment you run the dev server
       * with `--host` to reach it from another machine, browsing to it by its *name*
       * ("Blocked request. This host is not allowed.") fails, while its IP works. Which is a
       * confusing way to learn about a security feature.
       *
       * The box's own hostname is not a rebinding risk — resolving it already requires being
       * on the network the server was deliberately exposed to — so it is allowed by default,
       * on whatever machine this happens to be. WEB_ALLOWED_HOSTS (comma-separated) covers
       * anything else: a tailnet name, a reverse proxy, a LAN alias.
       *
       * Dev only. `nuxi build` output never sees this.
       */
      allowedHosts: [
        hostname(),
        ...(process.env.WEB_ALLOWED_HOSTS?.split(',').map((h) => h.trim()) ?? []),
      ].filter(Boolean),
    },
  },
  app: {
    head: {
      title: 'Interlock',
      // A page-level title wins over this; nothing sets one yet, so every tab reads
      // "Interlock" until a screen has a reason to say more.
      titleTemplate: '%s',
      meta: [
        { name: 'description', content: 'Signal-grade tracking for city & state legislation.' },
        // The masthead's ground colour, so mobile browser chrome doesn't frame a dark app
        // in white.
        { name: 'theme-color', content: '#0d0f12' },
      ],
      link: [
        // The mark itself. SVG only: it's a vector glyph, every browser that matters takes
        // one, and an .ico would be a second copy of the logo to keep in step with app.vue.
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },
})
