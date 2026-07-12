import { expect, test } from 'bun:test'
import { parseEnv } from './env'

test('parses a minimal env and applies cadence defaults', () => {
  const env = parseEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/interlock' })
  expect(env.LEGISTAR_POLL_MINUTES).toBe(30)
  expect(env.LEGISCAN_POLL_HOURS).toBe(4)
  expect(env.WEB_PORT).toBe(3000)
})

test('coerces numeric overrides from strings', () => {
  const env = parseEnv({
    DATABASE_URL: 'postgres://u:p@localhost:5432/interlock',
    LEGISTAR_POLL_MINUTES: '15',
  })
  expect(env.LEGISTAR_POLL_MINUTES).toBe(15)
})

test('rejects an env with no DATABASE_URL', () => {
  expect(() => parseEnv({})).toThrow()
})
