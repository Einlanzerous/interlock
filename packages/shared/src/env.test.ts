import { expect, test } from 'bun:test'
import { parseEnv } from './env'

test('parses a minimal env and applies cadence defaults', () => {
  const env = parseEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/interlock' })
  expect(env.CHI_CLERK_POLL_MINUTES).toBe(30)
  expect(env.LEGISCAN_POLL_HOURS).toBe(4)
  expect(env.WEB_PORT).toBe(3000)
})

test('coerces numeric overrides from strings', () => {
  const env = parseEnv({
    DATABASE_URL: 'postgres://u:p@localhost:5432/interlock',
    CHI_CLERK_POLL_MINUTES: '15',
  })
  expect(env.CHI_CLERK_POLL_MINUTES).toBe(15)
})

test('rejects an env with no DATABASE_URL', () => {
  expect(() => parseEnv({})).toThrow()
})

/**
 * The shape `.env.example` actually ships: every optional key present and blank, because
 * it tells the operator to leave them blank. This used to throw "Invalid email" on
 * ALERT_EMAIL_TO and take down anything that parsed env, `db:migrate` included.
 */
test('treats a blank optional key as absent, the way .env.example ships it', () => {
  const env = parseEnv({
    DATABASE_URL: 'postgres://u:p@localhost:5432/interlock',
    LEGISCAN_API_KEY: '',
    OPENSTATES_API_KEY: '',
    SMTP_URL: '',
    ALERT_EMAIL_TO: '',
    ALERT_EMAIL_FROM: '',
  })
  expect(env.ALERT_EMAIL_TO).toBeUndefined()
  expect(env.ALERT_EMAIL_FROM).toBeUndefined()
  expect(env.SMTP_URL).toBeUndefined()
  expect(env.LEGISCAN_API_KEY).toBeUndefined()
})

test('still rejects a non-blank malformed email', () => {
  expect(() =>
    parseEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/interlock',
      ALERT_EMAIL_TO: 'not-an-email',
    }),
  ).toThrow()
})
