import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

import { chromium } from '@playwright/test'

import { localnetUsers } from '../apps/web/src/auth/localnetFixtures'

const root = resolve(import.meta.dirname, '..')
const siloEnvFile = resolve(root, '.silo.env')
const composeFile = resolve(root, 'compose.yaml')
const oracleInstanceName = 'oracle'
const outputDir = resolve(root, 'artifacts/oracle')
const healthTimeoutMs = Number(process.env.PRESS_ORACLE_HEALTH_TIMEOUT_MS ?? `${4 * 60_000}`)
const shutdownTimeoutMs = 20_000
const widths = [360, 1280] as const
const schemes = ['light', 'dark'] as const
const targets = [
  { name: 'feed', path: '/' },
  { name: 'market-notes', path: '/c/market-notes' },
  // Identity + password gates are first-class editorial surfaces (apps/web/BRIEF.md,
  // ratified 2026-07-04). The signed-in oracle session still renders both: /login has
  // no authenticated redirect, and the seeded password page gates a non-owner viewer.
  { name: 'login', path: '/login' },
  { name: 'password-gate', path: '/p/market-notes/checkout-cohort-notes.html' },
] as const

type OracleEnv = NodeJS.ProcessEnv & Record<string, string>
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
    WORKSPACE_NAME: parsed.WORKSPACE_NAME ?? parsed.SILO_WORKSPACE ?? oracleInstanceName,
  }
}

function commandText(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ')
}

function run(command: string, args: readonly string[], env: OracleEnv): Promise<CommandResult> {
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
  env: OracleEnv,
): Promise<void> {
  const result = await run(command, args, env)
  if (result.code !== 0) {
    throw new Error(`${commandText(command, args)} exited with ${result.signal ?? result.code}`)
  }
}

function startSiloUp(env: OracleEnv): ChildProcess {
  const child = spawn('silo', ['up', oracleInstanceName], {
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

  throw new Error(`oracle localnet did not become healthy at ${url}: ${String(lastError)}`)
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

async function teardown(env: OracleEnv): Promise<void> {
  const result = await run('docker', ['compose', 'down', '-v', '--remove-orphans'], env)
  if (result.code !== 0) {
    throw new Error(
      `docker compose down -v --remove-orphans exited with ${result.signal ?? result.code}`,
    )
  }
}

function logCleanupError(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`${action} failed during oracle cleanup: ${message}`)
}

function makeOracleEnv(siloEnv: SiloEnv): OracleEnv {
  return {
    ...process.env,
    ...siloEnv,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    COMPOSE_FILE: composeFile,
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

async function captureViewport(input: {
  readonly baseURL: string
  readonly scheme: (typeof schemes)[number]
  readonly width: (typeof widths)[number]
}) {
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({
      baseURL: input.baseURL,
      colorScheme: input.scheme,
      viewport: { width: input.width, height: 900 },
    })
    try {
      const page = await context.newPage()
      await page.goto('/login?next=/', { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: 'Sign in to keep reading.' }).waitFor()
      await page.getByLabel('Email').fill(localnetUsers.secondUser.email)
      await page.getByLabel('Password').fill(localnetUsers.secondUser.password)
      await page.getByRole('button', { name: 'Sign in' }).click()
      const feedHeading = page.getByRole('heading', { name: 'Reports for close reading.' })
      try {
        await feedHeading.waitFor({ timeout: 5_000 })
      } catch (error) {
        if (!page.url().includes('/login')) {
          throw error
        }
        await page.getByRole('button', { name: 'Sign in' }).click()
        await feedHeading.waitFor()
      }
      await page.getByRole('article').first().waitFor()

      for (const target of targets) {
        // oxlint-disable-next-line no-await-in-loop -- Screenshots need one stable document at a time.
        await page.goto(target.path, { waitUntil: 'networkidle' })
        // oxlint-disable-next-line no-await-in-loop -- Font readiness belongs to the current document.
        await page.evaluate(() => document.fonts.ready)
        // oxlint-disable-next-line no-await-in-loop -- Oracle stills must not capture hover state.
        await page.mouse.move(0, 0)
        // oxlint-disable-next-line no-await-in-loop -- Let hover/focus paints settle before capture.
        await Bun.sleep(100)
        // oxlint-disable-next-line no-await-in-loop -- Full-page capture is the oracle artifact.
        await page.screenshot({
          path: resolve(outputDir, `${target.name}-${input.scheme}-${input.width}.png`),
          fullPage: true,
        })
      }
    } finally {
      await context.close()
    }
  } finally {
    await browser.close()
  }
}

async function main(): Promise<number> {
  const bootstrapEnv = {
    ...process.env,
    TILT_EDITOR: 'true',
    PRESS_SERVE_MODE: 'dev',
  } as OracleEnv
  let oracleEnv = bootstrapEnv
  let siloUp: ChildProcess | undefined
  let siloReadyForDown = false
  let cleanupPromise: Promise<Error[]> | undefined

  function cleanup(): Promise<Error[]> {
    if (cleanupPromise) {
      return cleanupPromise
    }

    cleanupPromise = (async () => {
      const errors: Error[] = []
      try {
        await stopSiloUp(siloUp)
      } catch (error) {
        logCleanupError('stopping silo up', error)
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
      if (siloReadyForDown) {
        try {
          await teardown(oracleEnv)
        } catch (error) {
          logCleanupError('docker compose down -v --remove-orphans', error)
          errors.push(error instanceof Error ? error : new Error(String(error)))
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

  await mkdir(outputDir, { recursive: true })

  let capturedOk = false
  try {
    await runRequired('silo', ['env', oracleInstanceName, '--force'], bootstrapEnv)
    const siloEnv = await readSiloEnv()
    oracleEnv = makeOracleEnv(siloEnv)
    siloReadyForDown = true

    siloUp = startSiloUp(oracleEnv)
    const siloExit = waitForExit(siloUp)
    await waitForHealth(siloEnv.PRESS_BASE_URL, siloExit, healthTimeoutMs)

    for (const scheme of schemes) {
      for (const width of widths) {
        // oxlint-disable-next-line no-await-in-loop -- Oracle filenames encode one viewport per pass.
        await captureViewport({ baseURL: siloEnv.PRESS_BASE_URL, scheme, width })
      }
    }

    capturedOk = true
  } finally {
    const cleanupErrors = await cleanup()
    if (capturedOk && cleanupErrors.length > 0) {
      capturedOk = false
    }
  }
  return capturedOk ? 0 : 1
}

void main()
  .then((code) => {
    process.exit(code)
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
