import { Pool } from 'pg'
import { parseEnv } from '@interlock/shared'
import { migrate } from './migrate'

/** `bun run db:migrate` — apply pending migrations and exit. */

const env = parseEnv()
const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 })

try {
  const applied = await migrate(pool)
  console.log(
    applied.length > 0
      ? `[db] applied ${applied.length} migration(s): ${applied.join(', ')}`
      : '[db] already up to date',
  )
} finally {
  await pool.end()
}
