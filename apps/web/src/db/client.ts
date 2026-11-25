import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { Pool as PgPool } from 'pg'

import { loadDbConfig } from './config'
import { schema } from './schema'

import type { WebDbConfig } from './config'

export type PressDb = NodePgDatabase<typeof schema>

const POOL_MAX_CONNECTIONS = 10
const POOL_CONNECTION_TIMEOUT_MS = 10_000
const POOL_IDLE_TIMEOUT_MS = 30_000
const POOL_QUERY_TIMEOUT_MS = 30_000

declare global {
  // oxlint-disable-next-line no-var -- One dev reloads modules; keep a single pool per process.
  var pressDbPool: PgPool | undefined
}

let cachedConfig: WebDbConfig | undefined
let cachedDb: PressDb | undefined

export function getDbConfig(): WebDbConfig {
  cachedConfig ??= loadDbConfig()
  return cachedConfig
}

export function getPool(): PgPool {
  if (!globalThis.pressDbPool) {
    globalThis.pressDbPool = new Pool({
      connectionString: getDbConfig().databaseUrl,
      max: POOL_MAX_CONNECTIONS,
      connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
      query_timeout: POOL_QUERY_TIMEOUT_MS,
    })
  }
  return globalThis.pressDbPool
}

export function getDb(): PressDb {
  cachedDb ??= drizzle(getPool(), { schema })
  return cachedDb
}

export async function closeDb(): Promise<void> {
  const activePool = globalThis.pressDbPool
  globalThis.pressDbPool = undefined
  cachedDb = undefined
  cachedConfig = undefined
  if (activePool) {
    await activePool.end()
  }
}
