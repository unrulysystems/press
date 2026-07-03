import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { db as dbClient } from '../apps/web/src/db/client'

import {
  localnetDemoCollections,
  localnetDemoPages,
  localnetUsers,
} from '../apps/web/src/auth/localnetFixtures'
import { startLocalnet } from './localnet'

const root = resolve(import.meta.dirname, '..')
const devDir = resolve(root, '.dev')
const agentEnvPath = resolve(devDir, 'agent.env')
let agentTokenId: string | undefined
let tokenDb: typeof dbClient | undefined
let closeTokenDb: (() => Promise<void>) | undefined
let cleanupStarted = false

const localnetUserCards = [
  { role: 'owner', user: localnetUsers.owner },
  { role: 'second', user: localnetUsers.secondUser },
  { role: 'wrong-domain', user: localnetUsers.wrongDomain },
  { role: 'external', user: localnetUsers.external },
  { role: 'admin', user: localnetUsers.admin },
] as const

function applyProcessEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value
  }
}

function tokenName(): string {
  return `dev-share-agent-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`
}

function printWhosWho(baseUrl: string): void {
  console.log('')
  console.log('press localnet shared session')
  console.log(`base url: ${baseUrl}`)
  console.log('')
  console.log('seeded users:')
  for (const { role, user } of localnetUserCards) {
    console.log(`  - ${role}: ${user.email} / ${user.password}`)
  }
  console.log('')
  console.log('seeded collections:')
  for (const collection of localnetDemoCollections) {
    console.log(
      `  - ${collection.slug}: defaultVisibility=${collection.defaultVisibility}, owner=${collection.ownerEmail}`,
    )
  }
  console.log('')
  console.log('example pages:')
  for (const page of localnetDemoPages.slice(0, 3)) {
    console.log(`  - ${baseUrl}/p/${page.collectionSlug}/${page.fileSlug}`)
  }
}

async function writeAgentEnv(baseUrl: string, token: string): Promise<void> {
  await mkdir(devDir, { recursive: true })
  await writeFile(agentEnvPath, `PRESS_TOKEN=${token}\nPRESS_URL=${baseUrl}\n`, { mode: 0o600 })
  await chmod(agentEnvPath, 0o600)
}

async function mintAgentToken(baseUrl: string, env: Record<string, string>): Promise<void> {
  applyProcessEnv(env)
  const [{ findUserIdByEmail, mintApiTokenRecordForUser }, dbModule] = await Promise.all([
    import('../apps/web/src/auth/apiTokens'),
    import('../apps/web/src/db/client'),
  ])
  tokenDb = dbModule.db
  closeTokenDb = dbModule.closeDb

  const userId = await findUserIdByEmail(dbModule.db, localnetUsers.owner.email)
  const minted = await mintApiTokenRecordForUser(dbModule.db, { userId, name: tokenName() })
  agentTokenId = minted.id
  await writeAgentEnv(baseUrl, minted.token)
  console.log('')
  console.log(`agent env: ${agentEnvPath}`)
}

async function cleanupAgentToken(): Promise<void> {
  if (cleanupStarted) {
    return
  }
  cleanupStarted = true
  try {
    if (agentTokenId && tokenDb) {
      const { revokeApiToken } = await import('../apps/web/src/auth/apiTokens')
      await revokeApiToken(tokenDb, agentTokenId)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
  } finally {
    await rm(agentEnvPath, { force: true }).catch(() => {})
    if (closeTokenDb) {
      await closeTokenDb().catch(() => {})
    }
  }
}

await startLocalnet(process.argv.slice(2), {
  async onReady({ baseUrl, env }) {
    printWhosWho(baseUrl)
    await mintAgentToken(baseUrl, env)
  },
  onShutdown: cleanupAgentToken,
})
