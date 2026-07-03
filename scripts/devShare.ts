import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { db as dbClient } from '../apps/web/src/db/client'

import {
  localnetDemoCollections,
  localnetDemoPages,
  localnetUsers,
} from '../apps/web/src/auth/localnetFixtures'

const root = resolve(import.meta.dirname, '..')
const siloEnvFile = resolve(root, '.silo.env')
const instanceName = 'main'
const healthTimeoutMs = Number(process.env.PRESS_DEV_SHARE_HEALTH_TIMEOUT_MS ?? `${4 * 60_000}`)
const shutdownTimeoutMs = 20_000
const devDir = resolve(root, '.dev')
const agentEnvPath = resolve(devDir, 'agent.env')
let agentTokenId: string | undefined
let tokenDb: typeof dbClient | undefined
let closeTokenDb: (() => Promise<void>) | undefined
let cleanupStarted = false

type DevShareEnv = NodeJS.ProcessEnv & Record<string, string>
type CommandResult = {
  readonly code: number
  readonly signal: NodeJS.Signals | null
}
type SiloEnv = {
  readonly COMPOSE_PROJECT_NAME: string
  readonly DATABASE_URL: string
  readonly PRESS_BASE_URL: string
  readonly PRESS_PORT: string
  readonly PRESS_POSTGRES_PORT: string
  readonly SILO_WORKSPACE?: string
  readonly WORKSPACE_NAME: string
}

const localnetUserCards = [
  { role: 'owner', user: localnetUsers.owner },
  { role: 'second', user: localnetUsers.secondUser },
  { role: 'wrong-domain', user: localnetUsers.wrongDomain },
  { role: 'external', user: localnetUsers.external },
  { role: 'admin', user: localnetUsers.admin },
] as const

function fail(message: string): never {
  throw new Error(message)
}

function required(parsed: Record<string, string>, name: keyof SiloEnv): string {
  const value = parsed[name]
  if (!value) {
    fail(`silo env did not provide ${name}`)
  }
  return value
}

function parseEnvFile(contents: string): Record<string, string> {
  const env: Record<string, string> = {}

  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const separator = trimmed.indexOf('=')
    if (separator === -1) {
      fail(`invalid .silo.env line: ${trimmed}`)
    }
    const name = trimmed.slice(0, separator)
    const rawValue = trimmed.slice(separator + 1)
    env[name] =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue
  }

  return env
}

async function readSiloEnv(): Promise<SiloEnv> {
  const parsed = parseEnvFile(await readFile(siloEnvFile, 'utf8'))
  return {
    COMPOSE_PROJECT_NAME: required(parsed, 'COMPOSE_PROJECT_NAME'),
    DATABASE_URL: required(parsed, 'DATABASE_URL'),
    PRESS_BASE_URL: required(parsed, 'PRESS_BASE_URL'),
    PRESS_PORT: required(parsed, 'PRESS_PORT'),
    PRESS_POSTGRES_PORT: required(parsed, 'PRESS_POSTGRES_PORT'),
    SILO_WORKSPACE: parsed.SILO_WORKSPACE,
    WORKSPACE_NAME: parsed.WORKSPACE_NAME ?? parsed.SILO_WORKSPACE ?? instanceName,
  }
}

function commandText(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ')
}

function run(command: string, args: readonly string[], env: DevShareEnv): Promise<CommandResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, [...args], {
      cwd: root,
      env,
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      resolveRun({ code: code ?? (signal ? 1 : 0), signal })
    })
  })
}

async function runRequired(
  command: string,
  args: readonly string[],
  env: DevShareEnv,
): Promise<void> {
  const result = await run(command, args, env)
  if (result.code !== 0) {
    throw new Error(`${commandText(command, args)} exited with ${result.signal ?? result.code}`)
  }
}

function startSiloUp(env: DevShareEnv): ChildProcess {
  const child = spawn('silo', ['up', instanceName], {
    cwd: root,
    detached: process.platform !== 'win32',
    env,
    stdio: 'inherit',
  })
  child.on('error', (error) => {
    console.error(`silo up failed to start: ${error.message}`)
  })
  return child
}

function waitForExit(child: ChildProcess): Promise<CommandResult> {
  return new Promise((resolveExit) => {
    child.once('error', (error) => {
      console.error(error.message)
      resolveExit({ code: 1, signal: null })
    })
    child.once('exit', (code, signal) => {
      resolveExit({ code: code ?? (signal ? 1 : 0), signal })
    })
  })
}

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms)
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForHealth(
  baseUrl: string,
  siloExit: Promise<CommandResult>,
  timeoutMs: number,
): Promise<void> {
  const url = `${baseUrl}/healthz`
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now())
    const probe = (async () => {
      try {
        const response = await fetchWithTimeout(url, Math.min(5_000, remaining))
        if (response.ok) {
          return 'ready' as const
        }
        lastError = new Error(`health check returned ${response.status}`)
      } catch (error) {
        lastError = error
      }
      await sleep(500)
      return 'retry' as const
    })()
    // oxlint-disable-next-line no-await-in-loop -- Polling observes one health state at a time.
    const result = await Promise.race([probe, siloExit])
    if (result === 'ready') {
      return
    }
    if (result !== 'retry') {
      throw new Error(
        `silo up exited before ${url} became healthy: ${result.signal ?? result.code}`,
      )
    }
  }

  throw new Error(`dev:share localnet did not become healthy at ${url}: ${String(lastError)}`)
}

async function stopSiloUp(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }

  const exit = waitForExit(child)
  if (child.pid) {
    if (process.platform === 'win32') {
      child.kill('SIGTERM')
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error
        }
      }
    }
  }

  const result = await Promise.race([exit, sleep(shutdownTimeoutMs).then(() => 'timeout' as const)])
  if (result === 'timeout' && child.pid) {
    if (process.platform === 'win32') {
      child.kill('SIGKILL')
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error
        }
      }
    }
    await exit
  }
}

async function teardown(env: DevShareEnv): Promise<void> {
  const result = await run('silo', ['down', '--clean'], env)
  if (result.code !== 0) {
    throw new Error(`silo down --clean exited with ${result.signal ?? result.code}`)
  }
}

function logCleanupError(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`${action} failed during dev:share cleanup: ${message}`)
}

function makeDevShareEnv(siloEnv: SiloEnv): DevShareEnv {
  return {
    ...process.env,
    ...siloEnv,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    PRESS_SERVE_MODE: 'dev',
    TILT_EDITOR: 'true',
    PRESS_ALLOWED_DOMAINS: process.env.PRESS_ALLOWED_DOMAINS ?? 'send.it',
    PRESS_ADMIN_EMAILS: process.env.PRESS_ADMIN_EMAILS ?? 'admin@send.it',
    PRESS_STORAGE_DIR: `.press/silo/${siloEnv.WORKSPACE_NAME}/storage`,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'localnet-secret-at-least-32-bytes',
    PRESS_ENABLE_CREDENTIAL_AUTH: process.env.PRESS_ENABLE_CREDENTIAL_AUTH ?? '1',
    PRESS_MAX_UPLOAD_BYTES: process.env.PRESS_MAX_UPLOAD_BYTES ?? '26214400',
  }
}

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

async function main(): Promise<number> {
  const bootstrapEnv = {
    ...process.env,
    TILT_EDITOR: 'true',
    PRESS_SERVE_MODE: 'dev',
  } as DevShareEnv
  let devShareEnv = bootstrapEnv
  let siloUp: ChildProcess | undefined
  let siloReadyForDown = false
  let cleanupPromise: Promise<void> | undefined

  function cleanup(): Promise<void> {
    if (cleanupPromise) {
      return cleanupPromise
    }

    cleanupPromise = (async () => {
      try {
        await cleanupAgentToken()
      } catch (error) {
        logCleanupError('agent token cleanup', error)
      }
      try {
        await stopSiloUp(siloUp)
      } catch (error) {
        logCleanupError('stopping silo up', error)
      }
      if (siloReadyForDown) {
        try {
          await teardown(devShareEnv)
        } catch (error) {
          logCleanupError('silo down --clean', error)
        }
      }
    })()
    return cleanupPromise
  }

  async function handleSignal(signal: NodeJS.Signals): Promise<void> {
    await cleanup()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }

  process.once('SIGINT', () => {
    void handleSignal('SIGINT')
  })
  process.once('SIGTERM', () => {
    void handleSignal('SIGTERM')
  })

  try {
    await runRequired('silo', ['env', instanceName, '--force'], bootstrapEnv)
    const siloEnv = await readSiloEnv()
    devShareEnv = makeDevShareEnv(siloEnv)
    siloReadyForDown = true

    siloUp = startSiloUp(devShareEnv)
    const siloExit = waitForExit(siloUp)
    await waitForHealth(siloEnv.PRESS_BASE_URL, siloExit, healthTimeoutMs)

    printWhosWho(siloEnv.PRESS_BASE_URL)
    await mintAgentToken(siloEnv.PRESS_BASE_URL, devShareEnv)

    const result = await siloExit
    return result.code
  } finally {
    await cleanup()
  }
}

void main()
  .then((code) => {
    process.exit(code)
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
