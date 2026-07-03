import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

import { expect, test } from '@playwright/test'

import { localnetUsers } from '../apps/web/src/auth/localnetFixtures'
import { newE2EAPIContext } from './api'

import type { APIRequestContext, APIResponse } from '@playwright/test'

const root = resolve(import.meta.dirname, '..')

type IsolatedServer = {
  readonly baseURL: string
  readonly stop: () => Promise<void>
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate an isolated rate-limit server port'))
        return
      }
      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolvePort(port)
      })
    })
  })
}

async function waitForHealth(baseURL: string, child: ChildProcess, stderr: () => string) {
  const deadline = Date.now() + 30_000
  let lastError: unknown

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `isolated rate-limit server exited before health check: ${child.signalCode ?? child.exitCode}\n${stderr()}`,
      )
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- Bounded health polling observes one server state at a time.
      const response = await fetch(`${baseURL}/healthz`)
      if (response.ok) {
        return
      }
      lastError = new Error(`health check returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    // oxlint-disable-next-line no-await-in-loop -- Keep the boot poll cheap without busy-waiting.
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250))
  }

  throw new Error(
    `isolated rate-limit server did not become healthy at ${baseURL}: ${String(lastError)}\n${stderr()}`,
  )
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit()
      return
    }
    child.once('exit', () => resolveExit())
  })
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  child.kill('SIGTERM')
  const killed = await Promise.race([
    waitForExit(child).then(() => true),
    new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
  ])
  if (!killed) {
    child.kill('SIGKILL')
    await waitForExit(child)
  }
}

async function startIsolatedRateLimitServer(input: {
  readonly max: number
  readonly windowSeconds: number
}): Promise<IsolatedServer> {
  const port = await getFreePort()
  const baseURL = `http://127.0.0.1:${port}`
  let stderr = ''
  const child = spawn('nub', ['run', '--filter', '@press/web', 'serve:prod'], {
    cwd: root,
    env: {
      ...process.env,
      PRESS_PORT: `${port}`,
      PRESS_BASE_URL: baseURL,
      PRESS_PARENT_PID: `${process.pid}`,
      PRESS_RATE_LIMIT_SIGNIN_MAX: `${input.max}`,
      PRESS_RATE_LIMIT_SIGNIN_WINDOW: `${input.windowSeconds}`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })

  try {
    await waitForHealth(baseURL, child, () => stderr)
    return {
      baseURL,
      stop: () => stopServer(child),
    }
  } catch (error) {
    await stopServer(child)
    throw error
  }
}

async function signIn(api: APIRequestContext, password: string): Promise<APIResponse> {
  return await api.post('/api/auth/sign-in/email', {
    headers: { 'content-type': 'application/json' },
    data: {
      email: localnetUsers.owner.email,
      password,
      rememberMe: true,
    },
  })
}

function expectRateLimited(response: APIResponse, label: string): void {
  expect(response.status(), label).toBe(429)
  expect(response.headers()['x-retry-after'], `${label} retry header`).toBeDefined()
}

test('credential sign-in is rate limited by endpoint on an isolated server', async () => {
  const max = 3
  const windowSeconds = 2
  const server = await startIsolatedRateLimitServer({ max, windowSeconds })
  const api = await newE2EAPIContext({ baseURL: server.baseURL })

  try {
    for (let attempt = 1; attempt <= max; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- Sequential requests prove one client consumes one bucket.
      const response = await signIn(api, 'wrong-password')
      expect(response.status(), `failed attempt ${attempt}`).not.toBe(429)
      expect(response.status(), `failed attempt ${attempt}`).not.toBe(200)
    }

    const cappedFailure = await signIn(api, 'wrong-password')
    expectRateLimited(cappedFailure, 'cap plus one failed sign-in')

    const cappedSuccess = await signIn(api, localnetUsers.owner.password)
    expectRateLimited(cappedSuccess, 'correct password inside exhausted window')

    await new Promise((resolveSleep) => setTimeout(resolveSleep, (windowSeconds + 1) * 1000))

    const restored = await signIn(api, localnetUsers.owner.password)
    expect(restored.status(), 'correct password after limiter window expires').toBe(200)
  } finally {
    await api.dispose()
    await server.stop()
  }
})
