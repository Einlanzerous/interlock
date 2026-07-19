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
  vite: {
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

        // The brief's three-font system: Space Grotesk names things a human chose,
        // IBM Plex Sans carries prose, IBM Plex Mono carries anything a machine chose
        // (identifiers, enum values, and — per the brief — button and tab labels).
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap',
        },
      ],
    },
  },
})
