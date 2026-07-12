import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))

// Arbitrary constant, shared by anything that migrates this database (a future
// Go ingester included) so two processes racing at boot serialize instead of
// both applying 0001.
const ADVISORY_LOCK_KEY = 4_540_301 // "itlk-3"

/**
 * Apply pending .sql migrations in filename order. Each file runs exactly once,
 * inside its own transaction, tracked in schema_migrations — so a re-run is a
 * no-op and a failed migration rolls back cleanly without recording itself.
 * Returns the filenames applied this run (empty = already up to date).
 */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect()
  const applied: string[] = []
  try {
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY])
    await client.query(
      `create table if not exists schema_migrations (
         name       text primary key,
         applied_at timestamptz not null default now()
       )`,
    )

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
    const { rows } = await client.query<{ name: string }>('select name from schema_migrations')
    const done = new Set(rows.map((r) => r.name))

    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(join(dir, file), 'utf8')
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into schema_migrations (name) values ($1)', [file])
        await client.query('commit')
      } catch (err) {
        await client.query('rollback')
        throw new Error(`migration ${file} failed`, { cause: err })
      }
      applied.push(file)
    }
    return applied
  } finally {
    await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {})
    client.release()
  }
}
