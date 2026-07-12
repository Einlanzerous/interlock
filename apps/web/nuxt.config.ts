// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },
  // The shared package is published as TypeScript source, so Vite must transpile it.
  build: { transpile: ['@interlock/shared'] },
  runtimeConfig: {
    databaseUrl: process.env.DATABASE_URL ?? '',
  },
  devServer: {
    port: Number(process.env.WEB_PORT ?? 3000),
  },
})
