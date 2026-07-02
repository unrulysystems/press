import { createServer } from 'node:net'
import { spawn } from 'node:child_process'

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
  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browserPath,
    PRESS_PORT: pressPort,
    PRESS_POSTGRES_PORT: postgresPort,
    PRESS_BASE_URL: process.env.PRESS_BASE_URL ?? `http://127.0.0.1:${pressPort}`,
  }

  await run('playwright', ['install', 'chromium'], env)
  await run('playwright', ['test', '--reporter=line'], env)
}

void main()
