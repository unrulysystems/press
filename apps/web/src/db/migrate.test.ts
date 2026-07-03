import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { applyMigrations, type MigrationDatabase } from './migrate'

type MigrationRow = {
  readonly id: string
  readonly checksum: string | null
}

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
} {
  const applied = new Map<string, string | null>()
  const db: MigrationDatabase = {
    async execute<Row = unknown>(query: unknown) {
      const text = queryText(query)
      if (text.includes('select id, checksum from "__press_migrations"')) {
        const rows = [...applied].map(([id, checksum]) => ({ id, checksum }) satisfies MigrationRow)
        return {
          rows: rows as Row[],
        }
      }
      if (text.includes('insert into "__press_migrations"')) {
        const [id, migrationChecksum] = queryParams(query)
        if (!id || !migrationChecksum) {
          throw new Error(`insert migration query missing parameters: ${text}`)
        }
        applied.set(id, migrationChecksum)
      }
      return { rows: [] }
    },
    async transaction(callback) {
      await callback(db)
    },
  }
  return { db, applied }
}

async function migrationDir(contents: string): Promise<{
  readonly dir: string
  readonly path: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'press-migrations-'))
  const path = join(dir, '0000_init.sql')
  await writeFile(path, contents)
  return { dir, path }
}

describe('applyMigrations', () => {
  test('fails closed when an applied migration file drifts', async () => {
    const { dir, path } = await migrationDir('create table example (id text primary key);')
    const fake = createFakeMigrationDb()

    await applyMigrations(fake.db, dir)
    expect(fake.applied.get('0000_init.sql')).toEqual(expect.any(String))

    await writeFile(path, 'create table example (id text primary key, name text);')
    await expect(applyMigrations(fake.db, dir)).rejects.toThrow(
      /migration 0000_init\.sql checksum mismatch/,
    )
  })

  test('allows legacy applied rows with null checksums', async () => {
    const { dir } = await migrationDir('create table example (id text primary key);')
    const fake = createFakeMigrationDb()
    fake.applied.set('0000_init.sql', null)

    await expect(applyMigrations(fake.db, dir)).resolves.toBeUndefined()
  })
})
