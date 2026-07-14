// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },
  // Workspace packages are published as TypeScript source, so Vite must transpile them.
  build: { transpile: ['@interlock/shared', '@interlock/db'] },
  runtimeConfig: {
    databaseUrl: process.env.DATABASE_URL ?? '',
  },
  devServer: {
    port: Number(process.env.WEB_PORT ?? 3000),
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
