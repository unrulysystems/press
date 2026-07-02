import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

import { parseConfig } from '@press/core'

const root = resolve(import.meta.dirname, '..')
const composeFile = resolve(root, 'compose.yaml')
const projectName = 'press-localnet'

type LocalnetEnv = NodeJS.ProcessEnv & Record<string, string>

function withLocalnetDefaults(): LocalnetEnv {
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

function run(command: string, args: string[], env: LocalnetEnv): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveRun()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} exited with ${signal ?? code}`))
    })
  })
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

async function main(): Promise<void> {
  const env = withLocalnetDefaults()
  const config = parseConfig(env)
  await mkdir(dirname(config.storageDir), { recursive: true })
  await mkdir(config.storageDir, { recursive: true })

  let server: ChildProcess | undefined
  let shuttingDown = false

  async function down(exitCode: number): Promise<void> {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    server?.kill('SIGTERM')
    await run(
      'docker',
      ['compose', '-f', composeFile, '-p', projectName, 'down', '--volumes', '--remove-orphans'],
      env,
    )
    process.exit(exitCode)
  }

  process.on('SIGINT', () => {
    void down(130)
  })
  process.on('SIGTERM', () => {
    void down(0)
  })

  try {
    await run(
      'docker',
      ['compose', '-f', composeFile, '-p', projectName, 'up', '-d', '--wait', 'postgres'],
      env,
    )

    // One's dev server keeps localnet fast enough for the design loop. The
    // e2e floors still exercise the real apps/web app over HTTP from scratch.
    server = spawn('nub', ['run', '--filter', '@press/web', 'dev'], {
      cwd: root,
      env: { ...env, PRESS_PARENT_PID: `${process.pid}` },
      stdio: 'inherit',
    })
    server.on('error', (error) => {
      console.error(error.message)
      void down(1)
    })
    server.on('exit', (code, signal) => {
      if (!shuttingDown) {
        console.error(`dev server exited with ${signal ?? code}`)
        void down(1)
      }
    })

    await waitForHealth(`${config.baseUrl}/healthz`, 30_000)
    console.log(`press localnet ready at ${config.baseUrl}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    await down(1)
  }
}

void main()
