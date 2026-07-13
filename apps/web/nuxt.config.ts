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
})
