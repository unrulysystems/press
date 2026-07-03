import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const siloEnvFile = resolve(root, '.silo.env')
const e2eInstanceName = 'e2e'
const healthTimeoutMs = Number(process.env.PRESS_E2E_HEALTH_TIMEOUT_MS ?? `${4 * 60_000}`)
const shutdownTimeoutMs = 20_000

type E2EEnv = NodeJS.ProcessEnv & Record<string, string>
type CommandResult = {
  readonly code: number
  readonly signal: NodeJS.Signals | null
}
type SiloEnv = {
  readonly COMPOSE_PROJECT_NAME: string
  readonly PRESS_PORT: string
  readonly PRESS_POSTGRES_PORT: string
  readonly PRESS_BASE_URL: string
  readonly DATABASE_URL: string
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
    PRESS_PORT: required(parsed, 'PRESS_PORT'),
    PRESS_POSTGRES_PORT: required(parsed, 'PRESS_POSTGRES_PORT'),
    PRESS_BASE_URL: required(parsed, 'PRESS_BASE_URL'),
    DATABASE_URL: required(parsed, 'DATABASE_URL'),
  }
}

function commandText(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ')
}

function run(command: string, args: readonly string[], env: E2EEnv): Promise<CommandResult> {
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

async function runRequired(command: string, args: readonly string[], env: E2EEnv): Promise<void> {
  const result = await run(command, args, env)
  if (result.code !== 0) {
    throw new Error(`${commandText(command, args)} exited with ${result.signal ?? result.code}`)
  }
}

function startSiloUp(env: E2EEnv): ChildProcess {
  const child = spawn('silo', ['up', e2eInstanceName], {
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

  throw new Error(`e2e localnet did not become healthy at ${url}: ${String(lastError)}`)
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

async function teardown(composeProjectName: string | undefined, env: E2EEnv): Promise<void> {
  if (!composeProjectName) {
    return
  }

  const result = await run('silo', ['down', '--clean'], env)
  if (result.code !== 0) {
    console.error(`silo down --clean exited with ${result.signal ?? result.code}`)
  }
}

function logCleanupError(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`${action} failed during e2e cleanup: ${message}`)
}

function makeE2EEnv(siloEnv: SiloEnv): E2EEnv {
  return {
    ...process.env,
    ...siloEnv,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/tmp/press-ms-playwright',
    PRESS_SERVE_MODE: 'prod',
    TILT_EDITOR: 'true',
    PRESS_ALLOWED_DOMAINS: process.env.PRESS_ALLOWED_DOMAINS ?? 'send.it',
    PRESS_ADMIN_EMAILS: process.env.PRESS_ADMIN_EMAILS ?? 'admin@send.it',
    PRESS_STORAGE_DIR:
      process.env.PRESS_STORAGE_DIR ?? resolve(root, '.press/silo', e2eInstanceName, 'storage'),
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'localnet-secret-at-least-32-bytes',
    PRESS_ENABLE_CREDENTIAL_AUTH: process.env.PRESS_ENABLE_CREDENTIAL_AUTH ?? '1',
    PRESS_MAX_UPLOAD_BYTES: process.env.PRESS_MAX_UPLOAD_BYTES ?? `${25 * 1024 * 1024}`,
  }
}

function playwrightArgs(args: readonly string[]): string[] {
  const hasReporter = args.some((arg) => arg === '--reporter' || arg.startsWith('--reporter='))
  return hasReporter ? [...args] : [...args, '--reporter=line']
}

async function main(): Promise<number> {
  const bootstrapEnv = {
    ...process.env,
    TILT_EDITOR: 'true',
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/tmp/press-ms-playwright',
    PRESS_SERVE_MODE: 'prod',
  } as E2EEnv
  let e2eEnv = bootstrapEnv
  let composeProjectName: string | undefined
  let siloUp: ChildProcess | undefined
  let teardownStarted = false

  async function cleanup(): Promise<void> {
    if (teardownStarted) {
      return
    }
    teardownStarted = true
    try {
      await stopSiloUp(siloUp)
    } catch (error) {
      logCleanupError('stopping silo up', error)
    }
    try {
      await teardown(composeProjectName, e2eEnv)
    } catch (error) {
      logCleanupError('silo down --clean', error)
    }
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
    await runRequired('nub', ['run', '--filter', '@press/core', 'build'], bootstrapEnv)
    await runRequired('silo', ['env', e2eInstanceName, '--force'], bootstrapEnv)

    const siloEnv = await readSiloEnv()
    composeProjectName = siloEnv.COMPOSE_PROJECT_NAME
    e2eEnv = makeE2EEnv(siloEnv)

    siloUp = startSiloUp(e2eEnv)
    await waitForHealth(siloEnv.PRESS_BASE_URL, waitForExit(siloUp), healthTimeoutMs)

    await runRequired('playwright', ['install', 'chromium'], e2eEnv)
    const result = await run(
      'playwright',
      ['test', ...playwrightArgs(process.argv.slice(2))],
      e2eEnv,
    )
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
