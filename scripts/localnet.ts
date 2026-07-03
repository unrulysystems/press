import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

import { parseConfig } from '@press/core'

const root = resolve(import.meta.dirname, '..')
const composeFile = resolve(root, 'compose.yaml')
const projectName = 'press-localnet'

type LocalnetEnv = NodeJS.ProcessEnv & Record<string, string>
type ServerMode = 'dev' | 'prod'
type LocalnetReadyContext = {
  readonly baseUrl: string
  readonly env: LocalnetEnv
  readonly projectName: string
  readonly serverMode: ServerMode
}
type LocalnetBeforeServerContext = LocalnetReadyContext
type LocalnetOptions = {
  readonly beforeServer?: (context: LocalnetBeforeServerContext) => Promise<void> | void
  readonly env?: LocalnetEnv
  readonly exitOnServerExit?: boolean
  readonly prepareDb?: 'migrate-and-seed' | 'none'
  readonly onReady?: (context: LocalnetReadyContext) => Promise<void> | void
  readonly onShutdown?: () => Promise<void> | void
  readonly projectName?: string
}
type LocalnetHandle = LocalnetReadyContext & {
  readonly stop: () => Promise<void>
}

export function parseServerMode(args: readonly string[]): ServerMode {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--prod-serve') {
      return 'prod'
    }
    if (arg === '--server' && args[index + 1]) {
      const value = args[index + 1]
      if (value === 'dev' || value === 'prod') {
        return value
      }
      throw new Error(`unsupported localnet server mode: ${value}`)
    }
    if (arg.startsWith('--server=')) {
      const value = arg.slice('--server='.length)
      if (value === 'dev' || value === 'prod') {
        return value
      }
      throw new Error(`unsupported localnet server mode: ${value}`)
    }
  }
  return 'dev'
}

export function withLocalnetDefaults(): LocalnetEnv {
  const env = { ...process.env } as LocalnetEnv
  env.NODE_ENV ??= 'development'
  env.PRESS_PORT ??= '4174'
  env.PRESS_POSTGRES_PORT ??= '54329'
  env.PRESS_BASE_URL ??= `http://127.0.0.1:${env.PRESS_PORT}`
  env.PRESS_ALLOWED_DOMAINS ??= 'send.it'
  env.PRESS_ADMIN_EMAILS ??= 'admin@send.it'
  env.DATABASE_URL ??= `postgres://press:press@127.0.0.1:${env.PRESS_POSTGRES_PORT}/press`
  env.PRESS_STORAGE_DIR ??= resolve(root, '.press/localnet/storage')
  env.BETTER_AUTH_SECRET ??= 'localnet-secret-at-least-32-bytes'
  env.PRESS_ENABLE_CREDENTIAL_AUTH ??= '1'
  env.PRESS_MAX_UPLOAD_BYTES ??= `${25 * 1024 * 1024}`
  return env
}

function run(
  command: string,
  args: string[],
  env: LocalnetEnv,
  options: { readonly timeoutMs?: number } = {},
): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: 'inherit',
    })
    let timedOut = false
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, options.timeoutMs)
      : undefined

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
      if (timedOut) {
        reject(new Error(`${command} ${args.join(' ')} timed out after ${options.timeoutMs}ms`))
        return
      }
      if (code === 0) {
        resolveRun()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} exited with ${signal ?? code}`))
    })
  })
}

function productionBuildEnv(env: LocalnetEnv): LocalnetEnv {
  return {
    ...env,
    NODE_ENV: 'production',
    ONE_SERVER_URL: env.PRESS_BASE_URL,
    PRESS_BASE_URL: env.PRESS_BASE_URL,
    PRESS_ENABLE_CREDENTIAL_AUTH: '0',
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID ?? 'build-placeholder',
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET ?? 'build-placeholder',
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Polling observes one health state at a time.
      const response = await fetch(url)
      if (response.ok) {
        return
      }
      lastError = new Error(`health check returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    // oxlint-disable-next-line no-await-in-loop -- Polling uses bounded backoff between attempts.
    await Bun.sleep(250)
  }

  throw new Error(`localnet did not become healthy at ${url}: ${String(lastError)}`)
}

export async function startLocalnet(
  args: readonly string[] = process.argv.slice(2),
  options: LocalnetOptions = {},
): Promise<void> {
  let handle: LocalnetHandle | undefined
  let shuttingDown = false

  async function down(exitCode: number): Promise<void> {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    try {
      await options.onShutdown?.()
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
    }
    await handle?.stop()
    process.exit(exitCode)
  }

  process.on('SIGINT', () => {
    void down(130)
  })
  process.on('SIGTERM', () => {
    void down(0)
  })

  try {
    handle = await bootLocalnet(args, { ...options, exitOnServerExit: true })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    await down(1)
  }
}

export async function bootLocalnet(
  args: readonly string[] = process.argv.slice(2),
  options: LocalnetOptions = {},
): Promise<LocalnetHandle> {
  const serverMode = parseServerMode(args)
  const env = options.env ?? withLocalnetDefaults()
  const activeProjectName = options.projectName ?? projectName
  const config = parseConfig(env)
  await mkdir(dirname(config.storageDir), { recursive: true })
  await mkdir(config.storageDir, { recursive: true })

  let server: ChildProcess | undefined
  let shuttingDown = false

  function stopAndMaybeExit(exitCode: number): void {
    void (async () => {
      try {
        await options.onShutdown?.()
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
      }
      await stop()
      if (options.exitOnServerExit) {
        process.exit(exitCode)
      }
    })()
  }

  async function stop(): Promise<void> {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    server?.kill('SIGTERM')
    await run(
      'docker',
      [
        'compose',
        '-f',
        composeFile,
        '-p',
        activeProjectName,
        'down',
        '--volumes',
        '--remove-orphans',
      ],
      env,
      { timeoutMs: 30_000 },
    )
  }

  try {
    if (serverMode === 'prod') {
      await run('nub', ['run', 'build:web'], productionBuildEnv(env), { timeoutMs: 10 * 60_000 })
    }

    await run(
      'docker',
      ['compose', '-f', composeFile, '-p', activeProjectName, 'up', '-d', '--wait', 'postgres'],
      env,
      { timeoutMs: 60_000 },
    )
    if ((options.prepareDb ?? 'migrate-and-seed') === 'migrate-and-seed') {
      await run('nub', ['run', '--filter', '@press/web', 'db:migrate'], env, { timeoutMs: 60_000 })
      await run('nub', ['run', '--filter', '@press/web', 'db:seed'], env, { timeoutMs: 60_000 })
    }

    const context = {
      baseUrl: config.baseUrl,
      env,
      projectName: activeProjectName,
      serverMode,
    }
    await options.beforeServer?.(context)

    const serverScript = serverMode === 'prod' ? 'serve:prod' : 'dev'
    server = spawn('nub', ['run', '--filter', '@press/web', serverScript], {
      cwd: root,
      env: { ...env, PRESS_PARENT_PID: `${process.pid}` },
      stdio: 'inherit',
    })
    server.on('error', (error) => {
      console.error(error.message)
      stopAndMaybeExit(1)
    })
    server.on('exit', (code, signal) => {
      if (!shuttingDown) {
        if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') {
          stopAndMaybeExit(0)
          return
        }
        console.error(`${serverScript} server exited with ${signal ?? code}`)
        stopAndMaybeExit(1)
      }
    })

    await waitForHealth(`${config.baseUrl}/healthz`, 30_000)
    console.log(`press localnet ${serverMode} server ready at ${config.baseUrl}`)
    await options.onReady?.(context)
    return { ...context, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

if (import.meta.main) {
  void startLocalnet()
}
