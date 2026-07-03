import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'

import { chromium } from '@playwright/test'

import { localnetUsers } from '../apps/web/src/auth/localnetFixtures'

const root = resolve(import.meta.dirname, '..')
const outputDir = resolve(root, 'artifacts/oracle')
const widths = [360, 1280] as const
const schemes = ['light', 'dark'] as const
const targets = [
  { name: 'feed', path: '/' },
  { name: 'market-notes', path: '/c/market-notes' },
] as const

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate a local TCP port'))
        return
      }
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolvePort(address.port)
      })
    })
  })
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Health polling observes one state at a time.
      const response = await fetch(url)
      if (response.ok) {
        return
      }
      lastError = new Error(`health check returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    // oxlint-disable-next-line no-await-in-loop -- Bounded startup backoff.
    await Bun.sleep(250)
  }

  throw new Error(`localnet did not become healthy at ${url}: ${String(lastError)}`)
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolveExit) => {
    child.once('exit', () => resolveExit())
  })
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
      await page.goto('/login?next=/')
      await page.getByLabel('Email').fill(localnetUsers.secondUser.email)
      await page.getByLabel('Password').fill(localnetUsers.secondUser.password)
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.getByRole('heading', { name: 'Reports for close reading.' }).waitFor()
      await page.getByRole('article').first().waitFor()

      for (const target of targets) {
        // oxlint-disable-next-line no-await-in-loop -- Screenshots need one stable document at a time.
        await page.goto(target.path)
        // oxlint-disable-next-line no-await-in-loop -- Font readiness belongs to the current document.
        await page.evaluate(() => document.fonts.ready)
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

async function main(): Promise<void> {
  const pressPort = process.env.PRESS_PORT ?? `${await getFreePort()}`
  const postgresPort = process.env.PRESS_POSTGRES_PORT ?? `${await getFreePort()}`
  const baseURL = `http://127.0.0.1:${pressPort}`
  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    PRESS_PORT: pressPort,
    PRESS_POSTGRES_PORT: postgresPort,
    PRESS_BASE_URL: process.env.PRESS_BASE_URL ?? baseURL,
    PRESS_ALLOWED_DOMAINS: process.env.PRESS_ALLOWED_DOMAINS ?? 'send.it',
    PRESS_ADMIN_EMAILS: process.env.PRESS_ADMIN_EMAILS ?? 'admin@send.it',
    DATABASE_URL:
      process.env.DATABASE_URL ?? `postgres://press:press@127.0.0.1:${postgresPort}/press`,
    PRESS_STORAGE_DIR:
      process.env.PRESS_STORAGE_DIR ?? resolve(root, '.press/localnet/oracle-storage'),
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'localnet-secret-at-least-32-bytes',
    PRESS_ENABLE_CREDENTIAL_AUTH: process.env.PRESS_ENABLE_CREDENTIAL_AUTH ?? '1',
    PRESS_MAX_UPLOAD_BYTES: process.env.PRESS_MAX_UPLOAD_BYTES ?? `${25 * 1024 * 1024}`,
  }

  await mkdir(outputDir, { recursive: true })

  const localnet = spawn('bun', ['scripts/localnet.ts'], {
    cwd: root,
    env,
    stdio: 'inherit',
  })

  try {
    await waitForHealth(`${env.PRESS_BASE_URL}/healthz`, 60_000)

    for (const scheme of schemes) {
      for (const width of widths) {
        // oxlint-disable-next-line no-await-in-loop -- Oracle filenames encode one viewport per pass.
        await captureViewport({ baseURL: env.PRESS_BASE_URL, scheme, width })
      }
    }
  } finally {
    localnet.kill('SIGTERM')
    await waitForExit(localnet)
  }
}

void main()
