import { passwordHash, useAuthSession } from '../../utils/auth'
import { verifyPassword } from '../../utils/password'

/**
 * Establish a session from a correct password. Failure is uniform (401, same message)
 * whether the password is empty or merely wrong, so nothing here confirms guesses.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ password?: unknown }>(event)
  const submitted = typeof body?.password === 'string' ? body.password : ''

  const stored = passwordHash()
  if (!stored) {
    // Not the user's fault — the box was never given a password. Loud, distinct from a 401.
    console.error('[auth] AUTH_PASSWORD_HASH is unset — no login is possible until it is set')
    throw createError({ statusCode: 500, statusMessage: 'Authentication is not configured' })
  }

  if (!verifyPassword(submitted, stored)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid password' })
  }

  const session = await useAuthSession(event)
  await session.update({ user: 'operator', at: Date.now() })
  return { authenticated: true }
})
