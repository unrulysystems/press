import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { sql } from 'drizzle-orm'

import type { SQLWrapper } from 'drizzle-orm'

const migrationsDir = resolve(import.meta.dirname, 'migrations')
const MIGRATION_LOCK_KEY = 'press_schema_migrations'

type QueryResult = {
  readonly rows: readonly Record<string, unknown>[]
}

export type MigrationDatabase = {
  readonly execute: (query: SQLWrapper) => Promise<QueryResult>
  readonly transaction: (callback: (tx: MigrationDatabase) => Promise<void>) => Promise<void>
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

  const result = await db.execute(sql`select id, checksum from "__press_migrations"`)
  const map = new Map<string, string | null>()
  for (const row of result.rows) {
    if (
      typeof row.id !== 'string' ||
      (row.checksum !== null && row.checksum !== undefined && typeof row.checksum !== 'string')
    ) {
      throw new Error('__press_migrations row has unexpected shape')
    }
    map.set(row.id, row.checksum ?? null)
  }
  return map
}

export async function applyMigrations(
  db: MigrationDatabase,
  directory = migrationsDir,
): Promise<void> {
  const migrationFiles = (await readdir(directory)).filter((file) => file.endsWith('.sql'))
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target lacks Array#toSorted.
  const files = [...migrationFiles].sort()
  const migrationContents = await Promise.all(
    files.map(async (file) => {
      const migrationSql = await readFile(resolve(directory, file), 'utf8')
      return { file, migrationSql, migrationChecksum: checksum(migrationSql) }
    }),
  )

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK_KEY}))`)
    const applied = await appliedMigrations(tx)

    for (const { file, migrationSql, migrationChecksum } of migrationContents) {
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
      await tx.execute(sql.raw(migrationSql))
      // oxlint-disable-next-line no-await-in-loop -- Record each migration immediately after applying it.
      await tx.execute(
        sql`insert into "__press_migrations" (id, checksum) values (${file}, ${migrationChecksum})`,
      )
    }
  })
}

async function main(): Promise<void> {
  const { closeDb, getDb } = await import('./client')
  const database = getDb()
  const migrationDb: MigrationDatabase = {
    execute: async (query) => await database.execute(query),
    transaction: async (callback) => {
      await database.transaction(async (tx) => {
        const txDb: MigrationDatabase = {
          execute: async (query) => await tx.execute(query),
          transaction: async (inner) => inner(txDb),
        }
        await callback(txDb)
      })
    },
  }
  try {
    await applyMigrations(migrationDb)
  } finally {
    await closeDb()
  }
}

if (import.meta.main) {
  await main()
}
