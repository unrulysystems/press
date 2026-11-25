import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { applyMigrations, type MigrationDatabase } from './migrate'

type MigrationRow = {
  readonly id: string
  readonly checksum: string | null
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function queryChunks(query: unknown): readonly unknown[] {
  return (query as { readonly queryChunks?: readonly unknown[] }).queryChunks ?? []
}

function chunkText(chunk: unknown): string {
  if (typeof chunk === 'string') {
    return '?'
  }
  if (
    chunk &&
    typeof chunk === 'object' &&
    'value' in chunk &&
    Array.isArray((chunk as { readonly value: unknown }).value)
  ) {
    return (chunk as { readonly value: readonly string[] }).value.join('')
  }
  return ''
}

function queryText(query: unknown): string {
  return queryChunks(query).map(chunkText).join('')
}

function queryParams(query: unknown): readonly string[] {
  return queryChunks(query).filter((chunk): chunk is string => typeof chunk === 'string')
}

function createFakeMigrationDb(): {
  readonly db: MigrationDatabase
  readonly applied: Map<string, string | null>
  readonly executedSql: string[]
} {
  const applied = new Map<string, string | null>()
  const executedSql: string[] = []
  const db: MigrationDatabase = {
    async execute(query: unknown) {
      const text = queryText(query)
      if (text.includes('select id, checksum from "__press_migrations"')) {
        const rows = [...applied].map(([id, checksum]) => ({ id, checksum }) satisfies MigrationRow)
        return { rows }
      }
      if (text.includes('insert into "__press_migrations"')) {
        const [id, migrationChecksum] = queryParams(query)
        if (!id || !migrationChecksum) {
          throw new Error(`insert migration query missing parameters: ${text}`)
        }
        applied.set(id, migrationChecksum)
        return { rows: [] }
      }
      if (
        !text.includes('__press_migrations') &&
        !text.includes('pg_advisory_xact_lock') &&
        text.trim().length > 0
      ) {
        executedSql.push(text.trim())
      }
      return { rows: [] }
    },
    async transaction(callback) {
      await callback(db)
    },
  }
  return { db, applied, executedSql }
}

async function migrationDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'press-migrations-'))
  tempDirs.push(dir)
  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(join(dir, name), contents)),
  )
  return dir
}

describe('applyMigrations', () => {
  test('applies migrations in sorted order and is idempotent on re-run', async () => {
    const dir = await migrationDir({
      '0002_second.sql': 'alter table example add column name text;',
      '0001_first.sql': 'create table example (id text primary key);',
    })
    const fake = createFakeMigrationDb()

    await applyMigrations(fake.db, dir)
    expect(fake.executedSql).toEqual([
      'create table example (id text primary key);',
      'alter table example add column name text;',
    ])

    await applyMigrations(fake.db, dir)
    expect(fake.executedSql).toHaveLength(2)
  })

  test('fails closed when an applied migration file drifts', async () => {
    const dir = await migrationDir({
      '0000_init.sql': 'create table example (id text primary key);',
    })
    const fake = createFakeMigrationDb()

    await applyMigrations(fake.db, dir)
    expect(fake.applied.get('0000_init.sql')).toEqual(expect.any(String))

    await writeFile(
      join(dir, '0000_init.sql'),
      'create table example (id text primary key, name text);',
    )
    await expect(applyMigrations(fake.db, dir)).rejects.toThrow(
      /migration 0000_init\.sql checksum mismatch/,
    )
  })

  test('allows legacy applied rows with null checksums', async () => {
    const dir = await migrationDir({
      '0000_init.sql': 'create table example (id text primary key);',
    })
    const fake = createFakeMigrationDb()
    fake.applied.set('0000_init.sql', null)

    await expect(applyMigrations(fake.db, dir)).resolves.toBeUndefined()
  })
})
