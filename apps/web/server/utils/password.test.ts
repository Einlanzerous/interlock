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

test('a malformed stored hash fails closed instead of throwing', () => {
  expect(verifyPassword('anything', '')).toBe(false)
  expect(verifyPassword('anything', 'not-a-hash')).toBe(false)
  expect(verifyPassword('anything', 'scrypt$zzzz$zzzz')).toBe(false)
  expect(verifyPassword('anything', 'bcrypt$aa$bb')).toBe(false)
})
