import { passwordHash } from '../utils/auth'

/**
 * Fail loud, not silent (ITLK-13). If auth isn't configured, the app still boots — every
 * route just redirects to a login nobody can pass — so without this warning the symptom
 * ("I can't log in") is a mystery. Nitro runs server plugins once at startup.
 */
export default defineNitroPlugin(() => {
  const missing: string[] = []
  if (!passwordHash()) missing.push('AUTH_PASSWORD_HASH')

  const secret = process.env.SESSION_PASSWORD
  if (!secret || secret.length < 32) missing.push('SESSION_PASSWORD (≥32 chars)')

  if (missing.length > 0) {
    console.warn(
      `[auth] not fully configured — login will not work. Set: ${missing.join(', ')}. ` +
        'See docs/deploy.md.',
    )
  }
})
