import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { sql } from 'drizzle-orm'

const migrationsDir = resolve(import.meta.dirname, 'migrations')

type QueryResult<Row> = {
  readonly rows: readonly Row[]
}

export type MigrationDatabase = {
  readonly execute: <Row = unknown>(query: unknown) => Promise<QueryResult<Row>>
  readonly transaction: (callback: (tx: MigrationDatabase) => Promise<void>) => Promise<void>
}

type AppliedMigration = {
  readonly id: string
  readonly checksum: string | null
}

function checksum(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

async function appliedMigrations(db: MigrationDatabase): Promise<Map<string, string | null>> {
  await db.execute(sql`
    create table if not exists "__press_migrations" (
      id text primary key,
      applied_at timestamp not null default now(),
      checksum text
    )
  `)
  await db.execute(sql`alter table "__press_migrations" add column if not exists checksum text`)

  const result = await db.execute<AppliedMigration>(
    sql`select id, checksum from "__press_migrations"`,
  )
  return new Map(result.rows.map((row) => [row.id, row.checksum]))
}

export async function applyMigrations(
  db: MigrationDatabase,
  directory = migrationsDir,
): Promise<void> {
  const applied = await appliedMigrations(db)
  const migrationFiles = (await readdir(directory)).filter((file) => file.endsWith('.sql'))
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target lacks Array#toSorted.
  const files = [...migrationFiles].sort()

  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop -- Migration contents are read before per-file integrity checks.
    const migrationSql = await readFile(resolve(directory, file), 'utf8')
    const migrationChecksum = checksum(migrationSql)
    const storedChecksum = applied.get(file)
    if (storedChecksum !== undefined) {
      if (storedChecksum !== null && storedChecksum !== migrationChecksum) {
        throw new Error(
          `migration ${file} checksum mismatch: applied ${storedChecksum}, current ${migrationChecksum}`,
        )
      }
      continue
    }
    // oxlint-disable-next-line no-await-in-loop -- Each migration depends on the prior one.
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(migrationSql))
      await tx.execute(
        sql`insert into "__press_migrations" (id, checksum) values (${file}, ${migrationChecksum})`,
      )
    })
  }
}

async function main(): Promise<void> {
  const { closeDb, db } = await import('./client')
  try {
    await applyMigrations(db as unknown as MigrationDatabase)
  } finally {
    await closeDb()
  }
}

if (import.meta.main) {
  await main()
}
