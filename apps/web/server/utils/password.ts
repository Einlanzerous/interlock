import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Password hashing for the single trusted user (ITLK-13).
 *
 * Kept deliberately free of any h3/Nitro imports so the same code backs both the login
 * endpoint and the `auth:hash` CLI (`scripts/hash-password.ts`) — the operator generates a
 * hash on one machine and the server verifies it on another, from one implementation.
 *
 * scrypt is in `node:crypto` (no dependency), and it is a deliberately slow, salted KDF —
 * the point is that the plaintext password never lives in `.env`; only this hash does.
 *
 * The fields are `:`-delimited, NOT `$`-delimited (ITLK-20). This hash rides through
 * docker-compose `${VAR}` interpolation on its way into the container, and a `$` inside the
 * value gets eaten there as an (empty) variable reference — `scrypt$salt$hash` arrives as
 * `scrypt$salt`, and every login silently 401s. `:` is inert to that interpolation and never
 * appears in hex, so the value needs no escaping anywhere it travels.
 */

// scrypt's default cost (N=16384) is fine for a login that happens by hand; the operator
// isn't rate-limiting themselves. 64-byte derived key, 16-byte random salt per hash.
const KEYLEN = 64
const SALT_BYTES = 16
const SCHEME = 'scrypt'
const SEP = ':'

/** Produce a self-describing `scrypt:<saltHex>:<hashHex>` string to store in AUTH_PASSWORD_HASH. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES)
  const hash = scryptSync(plain, salt, KEYLEN)
  return [SCHEME, salt.toString('hex'), hash.toString('hex')].join(SEP)
}

/**
 * Constant-time check of a submitted password against a stored hash. Returns false — never
 * throws — for a malformed or empty stored value, so a missing/garbled AUTH_PASSWORD_HASH
 * fails the login rather than crashing the request.
 *
 * Splits on either delimiter so a legacy `$`-delimited hash (pre-ITLK-20) still verifies —
 * hex contains neither `:` nor `$`, so this stays unambiguous.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split(/[$:]/)
  if (parts.length !== 3 || parts[0] !== SCHEME) return false

  const salt = Buffer.from(parts[1], 'hex')
  const expected = Buffer.from(parts[2], 'hex')
  // A bad hex parse yields a short/empty buffer; length-guard so timingSafeEqual (which
  // throws on unequal lengths) is only ever handed matching sizes.
  if (salt.length !== SALT_BYTES || expected.length !== KEYLEN) return false

  const actual = scryptSync(plain, salt, KEYLEN)
  return timingSafeEqual(actual, expected)
}
