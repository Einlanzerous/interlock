import { isAuthenticated } from '../../utils/auth'

/**
 * Whether the caller is logged in. Never 401s (it's on the middleware allowlist) — the
 * route guard and the login page ask it precisely to decide *whether* to send someone to
 * login, so it must answer for the logged-out too.
 */
export default defineEventHandler(async (event) => {
  return { authenticated: await isAuthenticated(event) }
})
