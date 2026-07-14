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
      // The brief's three-font system: Space Grotesk names things a human chose,
      // IBM Plex Sans carries prose, IBM Plex Mono carries anything a machine chose
      // (identifiers, enum values, and — per the brief — button and tab labels).
      link: [
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
