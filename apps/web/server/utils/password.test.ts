import { expect, test } from 'bun:test'
import { hashPassword, verifyPassword } from './password'

test('a hash verifies against its own password', () => {
  const hash = hashPassword('correct horse battery staple')
  expect(verifyPassword('correct horse battery staple', hash)).toBe(true)
})

test('the wrong password does not verify', () => {
  const hash = hashPassword('correct horse battery staple')
  expect(verifyPassword('Correct Horse Battery Staple', hash)).toBe(false)
  expect(verifyPassword('', hash)).toBe(false)
})

test('two hashes of the same password differ (per-hash salt)', () => {
  expect(hashPassword('same')).not.toBe(hashPassword('same'))
})

test('emits the :-delimited format with no $ (safe for env interpolation)', () => {
  const hash = hashPassword('anything')
  expect(hash.startsWith('scrypt:')).toBe(true)
  expect(hash).not.toContain('$')
  expect(hash.split(':')).toHaveLength(3)
})

test('a legacy $-delimited hash (pre-ITLK-20) still verifies', () => {
  // Same salt/hash bytes, only the delimiter differs — what a pre-fix hash looks like.
  const legacy = hashPassword('legacy password').replaceAll(':', '$')
  expect(legacy).toContain('$')
  expect(verifyPassword('legacy password', legacy)).toBe(true)
  expect(verifyPassword('wrong', legacy)).toBe(false)
})

test('a malformed stored hash fails closed instead of throwing', () => {
  expect(verifyPassword('anything', '')).toBe(false)
  expect(verifyPassword('anything', 'not-a-hash')).toBe(false)
  expect(verifyPassword('anything', 'scrypt$zzzz$zzzz')).toBe(false)
  expect(verifyPassword('anything', 'bcrypt$aa$bb')).toBe(false)
})
