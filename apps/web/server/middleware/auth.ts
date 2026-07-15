import { isAuthenticated } from '../utils/auth'

/**
 * The real security boundary (ITLK-13): every `/api/**` route is gated here, in one place,
 * so a new endpoint is protected by default rather than by remembering to add a guard.
 *
 * Only the API is 401'd. Page/document and asset requests (`/`, `/_nuxt/**`, `/favicon.svg`)
 * pass through untouched and are redirected to `/login` client-side by `auth.global.ts` —
 * the server must still be able to render the login page itself.
 */

// Endpoints reachable without a session:
//  - health: container/uptime probes hit it before anyone logs in (see docker-compose.prod.yml).
//  - auth/*: login needs to be callable to *get* a session; session/logout must answer either way.
const PUBLIC_API = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/session',
])

export default defineEventHandler(async (event) => {
  const path = event.path.split('?')[0]
  if (!path.startsWith('/api/')) return
  if (PUBLIC_API.has(path)) return

  if (await isAuthenticated(event)) return

  throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
})
