/**
 * Client/SSR route guard (ITLK-13). The server middleware is what actually protects data;
 * this is the UX half — it keeps an unauthenticated visitor from ever rendering an app
 * screen (whose API calls would only 401 anyway) and sends them to `/login` instead.
 *
 * It asks the server on every navigation via `/api/auth/session`. `useRequestFetch` forwards
 * the incoming cookies during SSR so the first paint is decided correctly; on the client the
 * check is a single cheap request, which for a one-user app is a non-issue.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login') return

  const { authenticated } = await useRequestFetch()<{ authenticated: boolean }>(
    '/api/auth/session',
  )

  if (!authenticated) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})
