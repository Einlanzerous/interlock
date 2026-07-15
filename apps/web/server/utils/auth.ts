import { useSession, type H3Event } from 'h3'

/**
 * Session auth for the single trusted user (ITLK-13).
 *
 * The session is a *sealed cookie* (h3's `useSession`): the payload is encrypted and signed
 * with SESSION_PASSWORD and lives entirely in the cookie. There is no server-side session
 * store, which is exactly what a one-box deploy wants — a worker/web restart doesn't drop
 * anyone's login, and there's no table to migrate.
 *
 * Multi-user is explicitly deferred. The seam is `SessionData.user`: today it's the constant
 * `'operator'`, but it's where a real `user_id` lands later without reshaping any of this.
 */

export interface SessionData {
  /** Reserved seam for multi-user: a real user id arrives here later. */
  user: string
  /** When the session was established (ms epoch); handy for audit, not enforced. */
  at: number
}

// A month. Long enough that the operator isn't re-logging-in constantly; `maxAge` makes the
// cookie persistent, so the session survives a browser restart (an acceptance criterion),
// and also caps how long a leaked cookie stays valid.
const SESSION_MAX_AGE = 60 * 60 * 24 * 30

/** The single-user login password, stored hashed. Undefined = auth not configured yet. */
export function passwordHash(): string | undefined {
  const hash = process.env.AUTH_PASSWORD_HASH
  return hash && hash.trim() !== '' ? hash : undefined
}

// h3 requires ≥32 chars to seal; anything shorter (or unset) can't back a session at all.
function sessionPassword(): string | undefined {
  const secret = process.env.SESSION_PASSWORD
  return secret && secret.length >= 32 ? secret : undefined
}

/**
 * The one session, consistently configured. Every *write* caller (login/logout) goes through
 * here, so an unsealed session is a 500 they can surface — it means the box was never given a
 * SESSION_PASSWORD, which the operator must fix. Reads use `isAuthenticated` instead, which
 * treats the same misconfiguration as simply "not logged in" so the app degrades to the login
 * screen rather than 500-ing every route.
 */
export function useAuthSession(event: H3Event) {
  const password = sessionPassword()
  if (!password) {
    throw createError({
      statusCode: 500,
      statusMessage: 'SESSION_PASSWORD is unset or shorter than 32 characters',
    })
  }
  return useSession<SessionData>(event, {
    name: 'interlock_session',
    password,
    maxAge: SESSION_MAX_AGE,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // Off by default so a first boot over plain HTTP (no reverse proxy yet) can still log
      // in. Set AUTH_COOKIE_SECURE=true once the box is behind TLS — see docs/deploy.md.
      secure: process.env.AUTH_COOKIE_SECURE === 'true',
    },
  })
}

/**
 * True when the request carries a valid, populated session. Fail-closed: with no
 * SESSION_PASSWORD there can be no valid session, so this is `false` (not an error) and the
 * caller redirects to login — every route staying secure without bricking the whole app.
 */
export async function isAuthenticated(event: H3Event): Promise<boolean> {
  if (!sessionPassword()) return false
  const session = await useAuthSession(event)
  return typeof session.data.user === 'string' && session.data.user.length > 0
}
