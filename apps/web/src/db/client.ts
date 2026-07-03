import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import type { Pool as PgPool } from 'pg'

import { loadDbConfig } from './config'
import { schema } from './schema'

declare global {
  // eslint-disable-next-line no-var -- One dev reloads modules; keep a single pool per process.
  var pressDbPool: PgPool | undefined
}

export const dbConfig = loadDbConfig()

export const pool =
  globalThis.pressDbPool ??
  new Pool({
    connectionString: dbConfig.databaseUrl,
    max: 10,
  })

globalThis.pressDbPool = pool

export const db = drizzle(pool, { schema })

export async function closeDb(): Promise<void> {
  await pool.end()
  globalThis.pressDbPool = undefined
}
