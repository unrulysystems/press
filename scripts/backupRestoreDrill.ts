import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

type DrillEnv = NodeJS.ProcessEnv & Record<string, string>
type CommandResult = {
  readonly code: number
  readonly signal: NodeJS.Signals | null
  readonly stdout: Buffer
  readonly stderr: Buffer
}
type ProcessResult = {
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
type AclFacts = {
  readonly publicStatus: number
  readonly defaultNonHtmlStatus: number
}
type BaselineFacts = {
  readonly acl: AclFacts
  readonly blobHash: string
  readonly contentHash: string
}

const root = resolve(import.meta.dirname, '..')
const siloEnvFile = resolve(root, '.silo.env')
const instanceName = 'drill'
const healthTimeoutMs = Number(process.env.PRESS_DRILL_HEALTH_TIMEOUT_MS ?? `${4 * 60_000}`)
const shutdownTimeoutMs = 20_000
const publicCollection = 'market-notes'
const publicFile = 'agent-margin-review.html'
const defaultCollection = 'systems-review'
const defaultFile = 'latency-budget-audit.html'

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

function redactCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ')
}

function run(
  command: string,
  args: readonly string[],
  options: {
    readonly env?: DrillEnv
    readonly input?: Buffer
    readonly timeoutMs?: number
    readonly allowFailure?: boolean
  } = {},
): Promise<CommandResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, [...args], {
      cwd: root,
      env: options.env ?? process.env,
      stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let timedOut = false
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, options.timeoutMs)
      : undefined

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
    })
    child.on('error', (error) => {
      if (timeout) {
        clearTimeout(timeout)
      }
      reject(error)
    })
    child.on('exit', (code, signal) => {
      if (timeout) {
        clearTimeout(timeout)
      }
      const result = {
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }
      if (timedOut) {
        reject(new Error(`${redactCommand(command, args)} timed out after ${options.timeoutMs}ms`))
        return
      }
      if (!options.allowFailure && result.code !== 0) {
        reject(
          new Error(
            `${redactCommand(command, args)} exited with ${signal ?? result.code}\n${result.stderr.toString()}`,
          ),
        )
        return
      }
      resolveRun(result)
    })

    if (options.input) {
      child.stdin?.end(options.input)
    }
  })
}

function runForeground(
  command: string,
  args: readonly string[],
  env: DrillEnv,
): Promise<ProcessResult> {
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

async function runRequired(command: string, args: readonly string[], env: DrillEnv): Promise<void> {
  const result = await runForeground(command, args, env)
  if (result.code !== 0) {
    throw new Error(`${redactCommand(command, args)} exited with ${result.signal ?? result.code}`)
  }
}

async function runCapturedRequired(
  command: string,
  args: readonly string[],
  env: DrillEnv,
  timeoutMs: number,
): Promise<void> {
  await run(command, args, { env, timeoutMs })
}

function composeArgs(args: readonly string[]): string[] {
  return ['compose', ...args]
}

async function dockerCompose(
  env: DrillEnv,
  args: readonly string[],
  timeoutMs = 60_000,
): Promise<void> {
  await runCapturedRequired('docker', composeArgs(args), env, timeoutMs)
}

function startPressServer(env: DrillEnv): ChildProcess {
  const child = spawn('nub', ['run', '--filter', '@press/web', 'dev'], {
    cwd: root,
    detached: process.platform !== 'win32',
    env,
    stdio: 'inherit',
  })
  child.on('error', (error) => {
    console.error(`press server failed to start: ${error.message}`)
  })
  return child
}

function waitForExit(child: ChildProcess): Promise<ProcessResult> {
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
  serverExit: Promise<ProcessResult>,
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
    const result = await Promise.race([probe, serverExit])
    if (result === 'ready') {
      return
    }
    if (result !== 'retry') {
      throw new Error(
        `press server exited before ${url} became healthy: ${result.signal ?? result.code}`,
      )
    }
  }

  throw new Error(
    `backup/restore drill localnet did not become healthy at ${url}: ${String(lastError)}`,
  )
}

async function stopChildProcess(child: ChildProcess | undefined): Promise<void> {
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

async function siloDown(env: DrillEnv): Promise<void> {
  const result = await runForeground('silo', ['down', '--clean'], env)
  if (result.code !== 0) {
    throw new Error(`silo down --clean exited with ${result.signal ?? result.code}`)
  }
}

function logCleanupError(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`${action} failed during backup/restore drill cleanup: ${message}`)
}

function storageDirFromSiloEnv(siloEnv: SiloEnv): string {
  return `.press/silo/${siloEnv.WORKSPACE_NAME}/storage`
}

function storagePath(storageDir: string): string {
  return resolve(root, storageDir)
}

function makeDrillEnv(siloEnv: SiloEnv, storageDir: string): DrillEnv {
  return {
    ...process.env,
    ...siloEnv,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    TILT_EDITOR: 'true',
    COMPOSE_FILE: resolve(root, 'compose.yaml'),
    PRESS_SERVE_MODE: 'dev',
    PRESS_ALLOWED_DOMAINS: process.env.PRESS_ALLOWED_DOMAINS ?? 'send.it',
    PRESS_ADMIN_EMAILS: process.env.PRESS_ADMIN_EMAILS ?? 'admin@send.it',
    PRESS_STORAGE_DIR: storagePath(storageDir),
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'localnet-secret-at-least-32-bytes',
    PRESS_ENABLE_CREDENTIAL_AUTH: process.env.PRESS_ENABLE_CREDENTIAL_AUTH ?? '1',
    PRESS_MAX_UPLOAD_BYTES: process.env.PRESS_MAX_UPLOAD_BYTES ?? '26214400',
  }
}

function blobPath(storageDir: string): string {
  return resolve(storagePath(storageDir), publicCollection, publicFile)
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function postgresContainer(env: DrillEnv): Promise<string> {
  const container = `${env.COMPOSE_PROJECT_NAME}-postgres-1`
  await run(
    'docker',
    ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'press', '-d', 'press'],
    {
      env,
      timeoutMs: 15_000,
    },
  )
  return container
}

async function waitForPostgres(env: DrillEnv, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Postgres readiness is an ordered poll.
      await postgresContainer(env)
      return
    } catch (error) {
      lastError = error
      // oxlint-disable-next-line no-await-in-loop -- Backoff between readiness probes.
      await sleep(500)
    }
  }

  throw new Error(`postgres did not become ready: ${String(lastError)}`)
}

async function startEmptyPostgres(env: DrillEnv): Promise<void> {
  await dockerCompose(env, ['up', '-d', 'postgres'])
  await waitForPostgres(env, 60_000)
}

async function migrateAndSeed(env: DrillEnv, storageDir: string): Promise<void> {
  await mkdir(storagePath(storageDir), { recursive: true })
  await runCapturedRequired('nub', ['run', '--filter', '@press/web', 'db:migrate'], env, 60_000)
  await runCapturedRequired('nub', ['run', '--filter', '@press/web', 'db:seed'], env, 60_000)
}

async function destroyState(env: DrillEnv, storageDir: string): Promise<void> {
  await dockerCompose(env, ['down', '-v', '--remove-orphans'])
  await rm(storagePath(storageDir), { recursive: true, force: true })
}

async function querySingle(env: DrillEnv, sql: string): Promise<string> {
  const container = await postgresContainer(env)
  const result = await run(
    'docker',
    [
      'exec',
      container,
      'psql',
      '-U',
      'press',
      '-d',
      'press',
      '-t',
      '-A',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { env, timeoutMs: 15_000 },
  )
  const rows = result.stdout
    .toString()
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean)
  if (rows.length !== 1) {
    fail(`expected one SQL row for ${sql}, got ${rows.length}: ${result.stdout.toString()}`)
  }
  return rows[0] ?? fail(`SQL row unexpectedly missing for ${sql}`)
}

async function probeAcl(env: DrillEnv): Promise<AclFacts> {
  const publicResponse = await fetch(`${env.PRESS_BASE_URL}/p/${publicCollection}/${publicFile}`, {
    headers: { Accept: 'text/html' },
  })
  const defaultResponse = await fetch(
    `${env.PRESS_BASE_URL}/p/${defaultCollection}/${defaultFile}`,
    {
      headers: { Accept: 'application/json' },
    },
  )
  return {
    publicStatus: publicResponse.status,
    defaultNonHtmlStatus: defaultResponse.status,
  }
}

async function recordFacts(env: DrillEnv, storageDir: string): Promise<BaselineFacts> {
  const contentHash = await querySingle(
    env,
    `select "contentHash" from "page" where "collectionSlug" = '${publicCollection}' and "fileSlug" = '${publicFile}' and "archivedAt" is null`,
  )
  const facts = {
    acl: await probeAcl(env),
    blobHash: await sha256File(blobPath(storageDir)),
    contentHash,
  }
  if (facts.acl.publicStatus !== 200) {
    fail(`public ACL probe returned ${facts.acl.publicStatus}, expected 200`)
  }
  if (facts.acl.defaultNonHtmlStatus !== 401) {
    fail(`default non-HTML ACL probe returned ${facts.acl.defaultNonHtmlStatus}, expected 401`)
  }
  if (facts.contentHash !== facts.blobHash) {
    fail(`page contentHash ${facts.contentHash} did not match blob hash ${facts.blobHash}`)
  }
  return facts
}

async function takeBackup(env: DrillEnv, storageDir: string, backupDir: string): Promise<void> {
  const container = await postgresContainer(env)
  await mkdir(backupDir, { recursive: true })
  const dump = await run(
    'docker',
    ['exec', container, 'pg_dump', '-Fc', '--no-owner', '--no-privileges', '-U', 'press', 'press'],
    { env, timeoutMs: 60_000 },
  )
  await writeFile(resolve(backupDir, 'database.dump'), dump.stdout)
  await cp(storagePath(storageDir), resolve(backupDir, 'blobs'), { recursive: true })
}

async function restoreBackupToEmptyTarget(
  env: DrillEnv,
  storageDir: string,
  backupDir: string,
): Promise<void> {
  await startEmptyPostgres(env)
  const container = await postgresContainer(env)
  await run(
    'docker',
    [
      'exec',
      '-i',
      container,
      'pg_restore',
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '-U',
      'press',
      '-d',
      'press',
    ],
    {
      env,
      input: await readFile(resolve(backupDir, 'database.dump')),
      timeoutMs: 60_000,
    },
  )
  const targetStoragePath = storagePath(storageDir)
  await rm(targetStoragePath, { recursive: true, force: true })
  await mkdir(dirname(targetStoragePath), { recursive: true })
  await cp(resolve(backupDir, 'blobs'), targetStoragePath, { recursive: true })
}

function assertRestoredFacts(baseline: BaselineFacts, restored: BaselineFacts): void {
  if (restored.contentHash !== baseline.contentHash) {
    fail(`restored contentHash ${restored.contentHash} did not match ${baseline.contentHash}`)
  }
  if (restored.blobHash !== baseline.blobHash) {
    fail(`restored blob hash ${restored.blobHash} did not match ${baseline.blobHash}`)
  }
  if (restored.acl.publicStatus !== baseline.acl.publicStatus) {
    fail(
      `restored public ACL status ${restored.acl.publicStatus} did not match ${baseline.acl.publicStatus}`,
    )
  }
  if (restored.acl.defaultNonHtmlStatus !== baseline.acl.defaultNonHtmlStatus) {
    fail(
      `restored default ACL status ${restored.acl.defaultNonHtmlStatus} did not match ${baseline.acl.defaultNonHtmlStatus}`,
    )
  }
}

async function main(): Promise<number> {
  const bootstrapEnv = {
    ...process.env,
    TILT_EDITOR: 'true',
    PRESS_SERVE_MODE: 'dev',
  } as DrillEnv
  let tmp: string | undefined
  let env = bootstrapEnv
  let server: ChildProcess | undefined
  let envReadyForTeardown = false
  let cleanupStarted = false

  async function cleanup(): Promise<Error[]> {
    const errors: Error[] = []
    if (cleanupStarted) {
      return errors
    }
    cleanupStarted = true
    try {
      await stopChildProcess(server)
    } catch (error) {
      logCleanupError('stopping press server', error)
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
    if (envReadyForTeardown) {
      try {
        await destroyState(env, env.PRESS_STORAGE_DIR)
      } catch (error) {
        logCleanupError('docker compose down -v', error)
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
      try {
        await siloDown(env)
      } catch (error) {
        logCleanupError('silo down --clean', error)
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (tmp) {
      try {
        await rm(tmp, { recursive: true, force: true })
      } catch (error) {
        logCleanupError('temporary directory cleanup', error)
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    return errors
  }

  async function handleSignal(signal: NodeJS.Signals): Promise<void> {
    const cleanupErrors = await cleanup()
    process.exit(cleanupErrors.length > 0 ? 1 : signal === 'SIGINT' ? 130 : 143)
  }

  process.once('SIGINT', () => {
    void handleSignal('SIGINT')
  })
  process.once('SIGTERM', () => {
    void handleSignal('SIGTERM')
  })

  let exitCode = 1
  try {
    tmp = await mkdtemp(resolve(tmpdir(), 'press-backup-restore-drill-'))
    const backupDir = resolve(tmp, 'backup')

    await runRequired('silo', ['env', instanceName, '--force'], bootstrapEnv)
    const siloEnv = await readSiloEnv()
    const storageDir = storageDirFromSiloEnv(siloEnv)
    env = makeDrillEnv(siloEnv, storageDir)
    envReadyForTeardown = true

    await destroyState(env, storageDir)
    await startEmptyPostgres(env)
    await migrateAndSeed(env, storageDir)

    server = startPressServer(env)
    let serverExit = waitForExit(server)
    await waitForHealth(siloEnv.PRESS_BASE_URL, serverExit, healthTimeoutMs)
    const baseline = await recordFacts(env, storageDir)
    await takeBackup(env, storageDir, backupDir)

    await stopChildProcess(server)
    server = undefined

    await destroyState(env, storageDir)
    await restoreBackupToEmptyTarget(env, storageDir, backupDir)

    server = startPressServer(env)
    serverExit = waitForExit(server)
    await waitForHealth(siloEnv.PRESS_BASE_URL, serverExit, healthTimeoutMs)
    const restored = await recordFacts(env, storageDir)
    assertRestoredFacts(baseline, restored)

    console.log('PASS backup/restore drill')
    console.log(`page: ${publicCollection}/${publicFile}`)
    console.log(`contentHash: ${restored.contentHash}`)
    console.log(`blobSha256: ${restored.blobHash}`)
    console.log(
      `acl: public=${restored.acl.publicStatus} default-non-html=${restored.acl.defaultNonHtmlStatus}`,
    )
    console.log('snapshotOrder: database dump first, blob snapshot second')
    exitCode = 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    exitCode = 1
  }

  const cleanupErrors = await cleanup()
  return cleanupErrors.length > 0 ? 1 : exitCode
}

void main().then((code) => {
  process.exit(code)
})
