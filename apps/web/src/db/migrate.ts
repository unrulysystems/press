import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { sql } from 'drizzle-orm'

import { closeDb, db } from './client'

const migrationsDir = resolve(import.meta.dirname, 'migrations')

async function appliedMigrations(): Promise<Set<string>> {
  await db.execute(sql`
    create table if not exists "__press_migrations" (
      id text primary key,
      applied_at timestamp not null default now()
    )
  `)

  const result = await db.execute<{ id: string }>(sql`select id from "__press_migrations"`)
  return new Set(result.rows.map((row) => row.id))
}

async function main(): Promise<void> {
  const applied = await appliedMigrations()
  const migrationFiles = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql'))
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target lacks Array#toSorted.
  const files = [...migrationFiles].sort()

  for (const file of files) {
    if (applied.has(file)) {
      continue
    }
    // Migrations must apply in filename order; parallel execution would corrupt schema state.
    // oxlint-disable-next-line no-await-in-loop -- Migration contents are read immediately before applying.
    const migrationSql = await readFile(resolve(migrationsDir, file), 'utf8')
    // oxlint-disable-next-line no-await-in-loop -- Each migration depends on the prior one.
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(migrationSql))
      await tx.execute(sql`insert into "__press_migrations" (id) values (${file})`)
    })
  }
}

try {
  await main()
} finally {
  await closeDb()
}
