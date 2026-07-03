import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} exited with ${signal ?? code}`))
    })
  })
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate a local TCP port'))
        return
      }
      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

async function main(): Promise<void> {
  const pressPort = process.env.PRESS_PORT ?? `${await getFreePort()}`
  const postgresPort = process.env.PRESS_POSTGRES_PORT ?? `${await getFreePort()}`
  const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/tmp/press-ms-playwright'
  const root = resolvePath(import.meta.dirname, '..')
  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    PLAYWRIGHT_BROWSERS_PATH: browserPath,
    PRESS_PORT: pressPort,
    PRESS_POSTGRES_PORT: postgresPort,
    PRESS_BASE_URL: process.env.PRESS_BASE_URL ?? `http://127.0.0.1:${pressPort}`,
    PRESS_ALLOWED_DOMAINS: process.env.PRESS_ALLOWED_DOMAINS ?? 'send.it',
    PRESS_ADMIN_EMAILS: process.env.PRESS_ADMIN_EMAILS ?? 'admin@send.it',
    DATABASE_URL:
      process.env.DATABASE_URL ?? `postgres://press:press@127.0.0.1:${postgresPort}/press`,
    PRESS_STORAGE_DIR:
      process.env.PRESS_STORAGE_DIR ?? resolvePath(root, '.press/localnet/storage'),
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'localnet-secret-at-least-32-bytes',
    PRESS_ENABLE_CREDENTIAL_AUTH: process.env.PRESS_ENABLE_CREDENTIAL_AUTH ?? '1',
    PRESS_MAX_UPLOAD_BYTES: process.env.PRESS_MAX_UPLOAD_BYTES ?? `${25 * 1024 * 1024}`,
  }

  await run('playwright', ['install', 'chromium'], env)
  await run('playwright', ['test', ...process.argv.slice(2), '--reporter=line'], env)
}

void main()
