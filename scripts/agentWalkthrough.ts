import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { db as dbClient } from '../apps/web/src/db/client'

import { localnetUsers } from '../apps/web/src/auth/localnetFixtures'

// The agent walkthrough is the executable proof of the press-publish skill flow: mint a
// seeded token (NO real Google — REQ-AUTH-002), publish a report through the real `press`
// CLI, read it back at the returned URL, and confirm the ACL differentiates an authorized
// publisher from an unauthenticated reader. It reuses the isolated-silo lifecycle from
// scripts/e2e.ts on its own instance so it never collides with `main`/`e2e`.
const root = resolve(import.meta.dirname, '..')
const siloEnvFile = resolve(root, '.silo.env')
const composeFile = resolve(root, 'compose.yaml')
const pressCli = resolve(root, 'packages/cli/src/index.ts')
const instanceName = 'walkthrough'
const collection = 'walkthrough'
const healthTimeoutMs = Number(process.env.PRESS_WALKTHROUGH_HEALTH_TIMEOUT_MS ?? `${4 * 60_000}`)
const shutdownTimeoutMs = 20_000

type WalkthroughEnv = NodeJS.ProcessEnv & Record<string, string>
type CommandResult = { readonly code: number; readonly signal: NodeJS.Signals | null }
type CaptureResult = CommandResult & { readonly stdout: string }
type SiloEnv = {
  readonly COMPOSE_PROJECT_NAME: string
  readonly DATABASE_URL: string
  readonly PRESS_BASE_URL: string
  readonly PRESS_PORT: string
  readonly PRESS_POSTGRES_PORT: string
  readonly WORKSPACE_NAME: string
}

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
  const { readFile } = await import('node:fs/promises')
  const parsed = parseEnvFile(await readFile(siloEnvFile, 'utf8'))
  return {
    COMPOSE_PROJECT_NAME: required(parsed, 'COMPOSE_PROJECT_NAME'),
    DATABASE_URL: required(parsed, 'DATABASE_URL'),
    PRESS_BASE_URL: required(parsed, 'PRESS_BASE_URL'),
    PRESS_PORT: required(parsed, 'PRESS_PORT'),
    PRESS_POSTGRES_PORT: required(parsed, 'PRESS_POSTGRES_PORT'),
    WORKSPACE_NAME: parsed.WORKSPACE_NAME ?? parsed.SILO_WORKSPACE ?? instanceName,
  }
}

function commandText(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ')
}

function run(
  command: string,
  args: readonly string[],
  env: WalkthroughEnv,
): Promise<CommandResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, [...args], { cwd: root, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      resolveRun({ code: code ?? (signal ? 1 : 0), signal })
    })
  })
}

async function runRequired(
  command: string,
  args: readonly string[],
  env: WalkthroughEnv,
): Promise<void> {
  const result = await run(command, args, env)
  if (result.code !== 0) {
    throw new Error(`${commandText(command, args)} exited with ${result.signal ?? result.code}`)
  }
}

// Capture stdout from the `press` CLI so the harness can parse the --json envelope. stderr
// is inherited so failures stay visible; the token is only ever passed via env, never argv.
function runCapture(
  command: string,
  args: readonly string[],
  env: WalkthroughEnv,
): Promise<CaptureResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, [...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      resolveRun({ code: code ?? (signal ? 1 : 0), signal, stdout })
    })
  })
}

function startSiloUp(env: WalkthroughEnv): ChildProcess {
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

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
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
  throw new Error(`walkthrough localnet did not become healthy at ${url}: ${String(lastError)}`)
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

// Scoped teardown: down only THIS instance's compose project, keyed by the captured
// COMPOSE_PROJECT_NAME + absolute COMPOSE_FILE, lockfile-independent — matches the ratified
// isolation pattern so a concurrent `main` is never touched.
async function teardown(
  composeProjectName: string | undefined,
  env: WalkthroughEnv,
): Promise<void> {
  if (!composeProjectName) {
    return
  }
  const result = await run('docker', ['compose', 'down', '-v', '--remove-orphans'], {
    ...env,
    COMPOSE_FILE: composeFile,
    COMPOSE_PROJECT_NAME: composeProjectName,
  })
  if (result.code !== 0) {
    throw new Error(
      `docker compose down -v --remove-orphans exited with ${result.signal ?? result.code}`,
    )
  }
}

function logCleanupError(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`${action} failed during walkthrough cleanup: ${message}`)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function makeWalkthroughEnv(siloEnv: SiloEnv): WalkthroughEnv {
  return {
    ...process.env,
    ...siloEnv,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    COMPOSE_FILE: composeFile,
    PRESS_SERVE_MODE: 'prod',
    TILT_EDITOR: 'true',
    PRESS_ALLOWED_DOMAINS: process.env.PRESS_ALLOWED_DOMAINS ?? 'send.it',
    PRESS_ADMIN_EMAILS: process.env.PRESS_ADMIN_EMAILS ?? 'admin@send.it',
    PRESS_STORAGE_DIR:
      process.env.PRESS_STORAGE_DIR ??
      resolve(root, '.press/silo', siloEnv.WORKSPACE_NAME, 'storage'),
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'localnet-secret-at-least-32-bytes',
    PRESS_ENABLE_CREDENTIAL_AUTH: process.env.PRESS_ENABLE_CREDENTIAL_AUTH ?? '1',
    PRESS_MAX_UPLOAD_BYTES: process.env.PRESS_MAX_UPLOAD_BYTES ?? `${25 * 1024 * 1024}`,
  }
}

function reportHtml(title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>Published by the press agent walkthrough harness.</p></body></html>`
}

// Publish a report through the real `press` CLI (--json) and return the served URL. The
// token is supplied via PRESS_TOKEN in the environment, never on argv.
async function publishReport(
  env: WalkthroughEnv,
  file: string,
  fileSlug: string,
  visibility: 'public' | 'private',
): Promise<string> {
  const result = await runCapture(
    'bun',
    [
      pressCli,
      'publish',
      file,
      '--to',
      collection,
      '--as',
      fileSlug,
      '--visibility',
      visibility,
      '--json',
    ],
    env,
  )
  if (result.code !== 0) {
    throw new Error(
      `press publish (${visibility}) exited with ${result.signal ?? result.code}: ${result.stdout.trim()}`,
    )
  }
  const parsed = JSON.parse(result.stdout) as {
    readonly ok?: boolean
    readonly data?: { readonly url?: unknown }
  }
  if (!parsed.ok || typeof parsed.data?.url !== 'string') {
    throw new Error(`press publish (${visibility}) returned no url: ${result.stdout.trim()}`)
  }
  const url = parsed.data.url
  return url.startsWith('http') ? url : `${env.PRESS_BASE_URL}${url}`
}

async function assertStatus(url: string, expected: number, label: string): Promise<void> {
  const response = await fetchWithTimeout(url, 10_000)
  if (response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected} at ${url}, got ${response.status}`)
  }
  console.log(`  ok: ${label} → HTTP ${response.status}`)
}

async function assertListed(env: WalkthroughEnv, slugs: readonly string[]): Promise<void> {
  const result = await runCapture('bun', [pressCli, 'list', collection, '--json'], env)
  if (result.code !== 0) {
    throw new Error(`press list exited with ${result.signal ?? result.code}`)
  }
  const parsed = JSON.parse(result.stdout) as {
    readonly data?: { readonly pages?: readonly { readonly file?: string }[] }
  }
  const listed = new Set((parsed.data?.pages ?? []).map((page) => page.file))
  for (const slug of slugs) {
    if (!listed.has(slug)) {
      throw new Error(`press list did not include ${collection}/${slug}`)
    }
  }
  console.log(`  ok: press list shows ${slugs.join(', ')}`)
}

async function main(): Promise<number> {
  const bootstrapEnv = {
    ...process.env,
    TILT_EDITOR: 'true',
    PRESS_SERVE_MODE: 'prod',
  } as WalkthroughEnv
  let walkthroughEnv = bootstrapEnv
  let composeProjectName: string | undefined
  let siloUp: ChildProcess | undefined
  let tokenDb: typeof dbClient | undefined
  let closeTokenDb: (() => Promise<void>) | undefined
  let mintedTokenId: string | undefined
  let workDir: string | undefined
  let cleanupPromise: Promise<Error[]> | undefined

  function cleanup(): Promise<Error[]> {
    if (cleanupPromise) {
      return cleanupPromise
    }
    cleanupPromise = (async () => {
      const errors: Error[] = []
      if (mintedTokenId && tokenDb) {
        try {
          const { revokeApiToken } = await import('../apps/web/src/auth/apiTokens')
          await revokeApiToken(tokenDb, mintedTokenId)
        } catch (error) {
          logCleanupError('api token revocation', error)
          errors.push(asError(error))
        }
      }
      if (closeTokenDb) {
        try {
          await closeTokenDb()
        } catch (error) {
          logCleanupError('token database close', error)
          errors.push(asError(error))
        }
      }
      try {
        await stopSiloUp(siloUp)
      } catch (error) {
        logCleanupError('stopping silo up', error)
        errors.push(asError(error))
      }
      try {
        await teardown(composeProjectName, walkthroughEnv)
      } catch (error) {
        logCleanupError('docker compose down -v --remove-orphans', error)
        errors.push(asError(error))
      }
      if (workDir) {
        try {
          await rm(workDir, { recursive: true, force: true })
        } catch (error) {
          logCleanupError('temp report removal', error)
          errors.push(asError(error))
        }
      }
      return errors
    })()
    return cleanupPromise
  }

  async function handleSignal(signal: NodeJS.Signals): Promise<void> {
    const errors = await cleanup()
    process.exit(errors.length > 0 ? 1 : signal === 'SIGINT' ? 130 : 143)
  }

  process.once('SIGINT', () => {
    void handleSignal('SIGINT')
  })
  process.once('SIGTERM', () => {
    void handleSignal('SIGTERM')
  })

  let exitCode = 1
  try {
    await runRequired('nub', ['run', '--filter', '@press/core', 'build'], bootstrapEnv)
    await runRequired('silo', ['env', instanceName, '--force'], bootstrapEnv)

    const siloEnv = await readSiloEnv()
    composeProjectName = siloEnv.COMPOSE_PROJECT_NAME
    walkthroughEnv = makeWalkthroughEnv(siloEnv)

    siloUp = startSiloUp(walkthroughEnv)
    await waitForHealth(siloEnv.PRESS_BASE_URL, waitForExit(siloUp), healthTimeoutMs)

    // Mint a seeded owner API token directly (the interactive login path needs a browser;
    // agents use a provided token). This exercises the same token an agent would export as
    // PRESS_TOKEN. NO real Google.
    for (const [key, value] of Object.entries(walkthroughEnv)) {
      process.env[key] = value
    }
    const [{ findUserIdByEmail, mintApiTokenRecordForUser }, dbModule] = await Promise.all([
      import('../apps/web/src/auth/apiTokens'),
      import('../apps/web/src/db/client'),
    ])
    tokenDb = dbModule.db
    closeTokenDb = dbModule.closeDb
    const userId = await findUserIdByEmail(dbModule.db, localnetUsers.owner.email)
    const minted = await mintApiTokenRecordForUser(dbModule.db, {
      userId,
      name: 'agent-walkthrough',
    })
    mintedTokenId = minted.id

    const cliEnv: WalkthroughEnv = {
      ...walkthroughEnv,
      PRESS_HOST: siloEnv.PRESS_BASE_URL,
      PRESS_TOKEN: minted.token,
    }

    workDir = await mkdtemp(join(tmpdir(), 'press-walkthrough-'))
    const publicFile = join(workDir, 'public-report.html')
    const privateFile = join(workDir, 'private-report.html')
    await writeFile(publicFile, reportHtml('Walkthrough Public Report'))
    await writeFile(privateFile, reportHtml('Walkthrough Private Report'))

    // File slugs must end in .html (parseFileSlug: /^[a-z0-9][a-z0-9._-]{0,120}\.html$/).
    const publicSlug = 'public-report.html'
    const privateSlug = 'private-report.html'

    console.log('publishing reports through the press CLI...')
    const publicUrl = await publishReport(cliEnv, publicFile, publicSlug, 'public')
    const privateUrl = await publishReport(cliEnv, privateFile, privateSlug, 'private')

    console.log('verifying read-back and access control...')
    // Publisher/anyone can read the public page; an unauthenticated reader is denied the
    // private page. This proves publish + serve + ACL differentiation end to end.
    await assertStatus(publicUrl, 200, 'public page read-back (unauthenticated)')
    await assertStatus(privateUrl, 401, 'private page denied to unauthenticated reader')
    await assertListed(cliEnv, [publicSlug, privateSlug])

    console.log('agent walkthrough passed')
    exitCode = 0
  } finally {
    const cleanupErrors = await cleanup()
    if (exitCode === 0 && cleanupErrors.length > 0) {
      exitCode = 1
    }
  }
  return exitCode
}

void main()
  .then((code) => {
    process.exit(code)
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
