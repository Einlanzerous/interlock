#!/usr/bin/env bun
import { hashPassword } from '../apps/web/server/utils/password'

/**
 * Mint an AUTH_PASSWORD_HASH line for `.env` (ITLK-13). Run it with `bun run auth:hash`.
 *
 * Prefer the interactive prompt (no argument) so the plaintext never lands in your shell
 * history; passing it as an argument works too, for scripted setups.
 */

const arg = process.argv[2]
const password = arg && arg.length > 0 ? arg : prompt('Password:')

if (!password) {
  console.error('No password given. Usage: bun run auth:hash [password]')
  process.exit(1)
}

console.log('\nAdd this line to your .env:\n')
console.log(`AUTH_PASSWORD_HASH=${hashPassword(password)}`)
