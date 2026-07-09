import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { expect, test } from '@playwright/test'

import { localnetUsers } from '../apps/web/src/auth/localnetFixtures'
import { findUserIdByEmail } from '../apps/web/src/auth/apiTokens'
import { db } from '../apps/web/src/db/client'
import { findMatchingAuditEvent, findPage } from '../apps/web/src/publish/e2eSupport'
import { newE2EAPIContext } from './api'

const root = resolve(import.meta.dirname, '..')
const pressBin = resolve(root, 'packages/cli/src/index.ts')
const runSlug = `cli-${Date.now().toString(36)}`

type PressResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

type KeychainState = Record<string, string>

type PressEnv = NodeJS.ProcessEnv & {
  readonly PRESS_HOST: string
  readonly PRESS_E2E_KEYCHAIN_FILE: string
}

function baseProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.PRESS_TOKEN
  return env
}

function bunExecutable(): string {
  const result = spawnSync('which', ['bun'], {
    encoding: 'utf8',
    env: process.env,
  })
  const path = result.stdout.trim()
  if (result.status !== 0 || !path) {
    throw new Error('bun executable not found')
  }
  return path
}

function jsonLine(stdout: string): unknown {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const last = lines.at(-1)
  if (!last) {
    throw new Error('expected JSON output')
  }
  return JSON.parse(last)
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

async function makePressEnv(baseURL: string, label: string): Promise<PressEnv> {
  const dir = await mkdtemp(join(tmpdir(), `press-cli-${label}-`))
  const keychainFile = join(dir, 'keychain.json')
  return {
    ...baseProcessEnv(),
    PRESS_HOST: baseURL,
    PRESS_E2E_KEYCHAIN_FILE: keychainFile,
  }
}

async function makePressTokenEnv(baseURL: string, label: string, token: string): Promise<PressEnv> {
  const dir = await mkdtemp(join(tmpdir(), `press-cli-${label}-`))
  await symlink(bunExecutable(), join(dir, 'bun'))
  return {
    ...baseProcessEnv(),
    PATH: dir,
    PRESS_HOST: baseURL,
    PRESS_E2E_KEYCHAIN_FILE: join(dir, 'keychain.json'),
    PRESS_TOKEN: token,
  }
}

function runPress(args: readonly string[], env: PressEnv): Promise<PressResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(pressBin, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      resolveRun({ code: code ?? 1, stdout, stderr })
    })
  })
}

async function readStoredToken(env: PressEnv): Promise<string> {
  const raw = await readFile(env.PRESS_E2E_KEYCHAIN_FILE, 'utf8')
  const state = JSON.parse(raw) as KeychainState
  const token = Object.values(state)[0]
  if (!token) {
    throw new Error('stored token missing')
  }
  return token
}

async function loginViaLoopback(
  baseURL: string,
  env: PressEnv,
  userKey: keyof typeof localnetUsers,
) {
  const child = spawn(pressBin, ['login', '--no-open'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const exitResult = new Promise<PressResult>((resolveRun, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => resolveRun({ code: code ?? 1, stdout, stderr }))
  })
  const authorizeUrl = await new Promise<string>((resolveUrl, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      const match = /(http:\/\/127\.0\.0\.1:\d+\/cli\/authorize\?[^\s]+)/.exec(stdout)
      if (match?.[1]) {
        resolveUrl(match[1])
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`press login exited ${code}: ${stderr || stdout}`))
      }
    })
    setTimeout(() => reject(new Error('press login did not print authorize URL')), 10_000).unref()
  })

  const browserSession = await newE2EAPIContext({ baseURL })
  const signIn = await browserSession.post('/api/auth/sign-in/email', {
    headers: { 'content-type': 'application/json' },
    data: {
      email: localnetUsers[userKey].email,
      password: localnetUsers[userKey].password,
      rememberMe: true,
    },
  })
  expect(signIn.status()).toBe(200)

  const redirected = await browserSession.get(authorizeUrl)
  expect(redirected.status()).toBe(200)

  const result = await exitResult
  expect(result.code).toBe(0)
  expect(result.stdout).toContain(`logged in as ${localnetUsers[userKey].email}`)
}

test('press CLI loopback login, publish, list, page set, unpublish, and logout', async ({
  baseURL,
}) => {
  if (!baseURL) {
    throw new Error('Playwright baseURL missing')
  }

  const ownerEnv = await makePressEnv(baseURL, 'owner')
  const secondEnv = await makePressEnv(baseURL, 'second')
  const api = await newE2EAPIContext({ baseURL })
  const collectionSlug = `${runSlug}-flow`
  const reportPath = join(await mkdtemp(join(tmpdir(), 'press-report-')), 'report.html')
  await writeFile(reportPath, '<!doctype html><title>CLI Report</title><h1>CLI</h1>')

  await loginViaLoopback(baseURL, ownerEnv, 'owner')
  const ownerToken = await readStoredToken(ownerEnv)
  const ownerId = await findUserIdByEmail(db, localnetUsers.owner.email)

  const whoami = runPress(['whoami', '--json'], ownerEnv)
  await expect(whoami).resolves.toMatchObject({ code: 0 })
  expect(jsonLine((await whoami).stdout)).toMatchObject({
    ok: true,
    data: { user: { email: localnetUsers.owner.email } },
  })

  const tokenEnv = await makePressTokenEnv(baseURL, 'owner-token-env', ownerToken)
  const envWhoami = await runPress(['whoami', '--json'], tokenEnv)
  expect(envWhoami.code).toBe(0)
  expect(envWhoami.stderr).toBe('')
  expect(jsonLine(envWhoami.stdout)).toMatchObject({
    ok: true,
    data: { user: { email: localnetUsers.owner.email } },
  })

  const publish = await runPress(
    ['publish', reportPath, '--to', collectionSlug, '--visibility', 'public', '--json'],
    ownerEnv,
  )
  expect(publish.code).toBe(0)
  expect(jsonLine(publish.stdout)).toMatchObject({
    ok: true,
    data: {
      url: `${baseURL}/p/${collectionSlug}/report.html`,
      collection: collectionSlug,
      file: 'report.html',
      visibility: 'public',
    },
  })

  await writeFile(reportPath, '<!doctype html><title>CLI Report Updated</title><h1>Updated</h1>')
  const republish = await runPress(
    ['publish', reportPath, '--to', collectionSlug, '--json'],
    ownerEnv,
  )
  expect(republish.code).toBe(0)
  expect(jsonLine(republish.stdout)).toMatchObject({
    ok: true,
    data: { title: 'CLI Report Updated' },
  })

  await loginViaLoopback(baseURL, secondEnv, 'secondUser')
  const forbidden = await runPress(
    [
      'publish',
      reportPath,
      '--to',
      collectionSlug,
      '--as',
      'second.html',
      '--visibility',
      'public',
      '--json',
    ],
    secondEnv,
  )
  expect(forbidden.code).toBe(3)
  expect(jsonLine(forbidden.stdout)).toMatchObject({ ok: false })

  const passwordPublish = await runPress(
    [
      'publish',
      reportPath,
      '--to',
      collectionSlug,
      '--as',
      'secret.html',
      '--visibility',
      'password',
      '--json',
    ],
    ownerEnv,
  )
  expect(passwordPublish.code).toBe(0)
  const passwordBody = jsonLine(passwordPublish.stdout) as {
    readonly data: { readonly password: string }
  }
  expect(passwordBody.data.password).toEqual(expect.any(String))
  expect(countOccurrences(passwordPublish.stdout, passwordBody.data.password)).toBe(1)
  const passwordPage = await findPage(db, collectionSlug, 'secret.html')
  expect(passwordPage?.passwordHash).toEqual(expect.any(String))
  expect(passwordPage?.passwordHash).not.toBe(passwordBody.data.password)

  const listCollection = await runPress(['list', collectionSlug, '--json'], ownerEnv)
  expect(listCollection.code).toBe(0)
  expect(jsonLine(listCollection.stdout)).toMatchObject({
    ok: true,
    data: {
      pages: expect.arrayContaining([
        expect.objectContaining({ collection: collectionSlug, file: 'report.html' }),
        expect.objectContaining({ collection: collectionSlug, file: 'secret.html' }),
      ]),
    },
  })

  const setPage = await runPress(
    [
      'page',
      'set',
      `${collectionSlug}/report.html`,
      '--visibility',
      'private',
      '--allow',
      localnetUsers.secondUser.email,
      '--json',
    ],
    ownerEnv,
  )
  expect(setPage.code).toBe(0)
  expect(jsonLine(setPage.stdout)).toMatchObject({
    ok: true,
    data: { visibility: 'private' },
  })

  const secondList = await runPress(['list', collectionSlug, '--json'], secondEnv)
  expect(secondList.code).toBe(0)
  expect(jsonLine(secondList.stdout)).toMatchObject({
    ok: true,
    data: {
      pages: expect.arrayContaining([
        expect.objectContaining({ collection: collectionSlug, file: 'report.html' }),
      ]),
    },
  })

  const unpublish = await runPress(
    ['unpublish', `${collectionSlug}/report.html`, '--json'],
    ownerEnv,
  )
  expect(unpublish.code).toBe(0)
  expect((await api.get(`/p/${collectionSlug}/report.html`)).status()).toBe(404)

  const afterUnpublish = jsonLine(
    (await runPress(['list', collectionSlug, '--json'], ownerEnv)).stdout,
  ) as {
    readonly data: { readonly pages: readonly { readonly file: string }[] }
  }
  expect(afterUnpublish.data.pages.map((page) => page.file)).not.toContain('report.html')

  const logout = await runPress(['logout', '--json'], ownerEnv)
  expect(logout.code).toBe(0)
  expect(
    await findMatchingAuditEvent(db, {
      collectionSlug: null,
      action: 'token-revoke',
      userId: ownerId,
    }),
    'token-revoke audit event should exist',
  ).toBeDefined()
  expect(
    (
      await api.get('/api/cli/whoami', { headers: { authorization: `Bearer ${ownerToken}` } })
    ).status(),
  ).toBe(401)

  const unauthenticated = await runPress(['whoami', '--json'], ownerEnv)
  expect(unauthenticated.code).toBe(2)
  expect(jsonLine(unauthenticated.stdout)).toMatchObject({ ok: false })
})

test('press publish --password: custom password (PRESS_PAGE_PASSWORD) unlocks; weak rejected (F3)', async ({
  baseURL,
}) => {
  if (!baseURL) {
    throw new Error('Playwright baseURL missing')
  }
  const env = await makePressEnv(baseURL, 'custom-pw')
  const collectionSlug = `${runSlug}-custompw`
  const reportPath = join(await mkdtemp(join(tmpdir(), 'press-report-')), 'report.html')
  await writeFile(reportPath, '<!doctype html><title>Custom PW</title><h1>x</h1>')
  await loginViaLoopback(baseURL, env, 'owner')
  const api = await newE2EAPIContext({ baseURL })

  // strong custom password supplied out-of-band (never argv); the response echoes it once
  const strong = 'liberty-1776'
  const pub = await runPress(
    ['publish', reportPath, '--to', collectionSlug, '--as', 'secret.html', '--password', '--json'],
    { ...env, PRESS_PAGE_PASSWORD: strong },
  )
  expect(pub.code).toBe(0)
  expect(jsonLine(pub.stdout)).toMatchObject({
    ok: true,
    data: { visibility: 'password', password: strong },
  })

  // the custom password unlocks via the Basic (programmatic) channel
  const unlocked = await api.get(`/p/${collectionSlug}/secret.html`, {
    headers: { authorization: `Basic ${Buffer.from(`:${strong}`).toString('base64')}` },
  })
  expect(unlocked.status()).toBe(200)

  // a password shorter than the floor is rejected (400 → CLI error, no page written)
  const weak = await runPress(
    ['publish', reportPath, '--to', collectionSlug, '--as', 'weak.html', '--password', '--json'],
    { ...env, PRESS_PAGE_PASSWORD: 'short' },
  )
  expect(weak.code).not.toBe(0)
  expect(jsonLine(weak.stdout)).toMatchObject({ ok: false })
})

test('press publish human output: password guidance + private allowlist echo (F2/F4)', async ({
  baseURL,
}) => {
  if (!baseURL) {
    throw new Error('Playwright baseURL missing')
  }
  const env = await makePressEnv(baseURL, 'human-out')
  const collectionSlug = `${runSlug}-humanout`
  const reportPath = join(await mkdtemp(join(tmpdir(), 'press-report-')), 'report.html')
  await writeFile(reportPath, '<!doctype html><title>Human Out</title><h1>x</h1>')
  await loginViaLoopback(baseURL, env, 'owner')

  // password page (no --json) → password + reader guidance line
  const pw = await runPress(
    [
      'publish',
      reportPath,
      '--to',
      collectionSlug,
      '--as',
      'secret.html',
      '--visibility',
      'password',
    ],
    env,
  )
  expect(pw.code).toBe(0)
  expect(pw.stdout).toMatch(/password:/)
  expect(pw.stdout).toMatch(/enter this password on the page/i)

  // private page (no --json) → resolved allowlist echoed for the publisher
  const priv = await runPress(
    [
      'publish',
      reportPath,
      '--to',
      collectionSlug,
      '--as',
      'priv.html',
      '--visibility',
      'private',
      '--allow',
      localnetUsers.secondUser.email,
    ],
    env,
  )
  expect(priv.code).toBe(0)
  expect(priv.stdout).toContain(localnetUsers.secondUser.email)

  // --json stays machine-clean and carries the allowlist
  const privJson = await runPress(
    [
      'publish',
      reportPath,
      '--to',
      collectionSlug,
      '--as',
      'priv2.html',
      '--visibility',
      'private',
      '--allow',
      localnetUsers.secondUser.email,
      '--json',
    ],
    env,
  )
  expect(privJson.code).toBe(0)
  expect(jsonLine(privJson.stdout)).toMatchObject({
    ok: true,
    data: { visibility: 'private', allow: [localnetUsers.secondUser.email] },
  })
})

test('press move reports canonical URLs and redirect mode in JSON and human output', async ({
  baseURL,
}) => {
  if (!baseURL) {
    throw new Error('Playwright baseURL missing')
  }
  const env = await makePressEnv(baseURL, 'move')
  const collectionSlug = `${runSlug}-move`
  const reportPath = join(await mkdtemp(join(tmpdir(), 'press-report-')), 'report.html')
  await writeFile(reportPath, '<!doctype html><title>CLI Move</title><h1>stable bytes</h1>')
  await loginViaLoopback(baseURL, env, 'owner')
  const api = await newE2EAPIContext({ baseURL })

  const published = await runPress(
    ['publish', reportPath, '--to', collectionSlug, '--visibility', 'public', '--json'],
    env,
  )
  expect(published.code).toBe(0)

  const moved = await runPress(
    ['move', `${collectionSlug}/report.html`, `${collectionSlug}/moved.html`, '--json'],
    env,
  )
  expect(moved.code).toBe(0)
  expect(moved.stderr).toBe('')
  expect(jsonLine(moved.stdout)).toEqual({
    ok: true,
    data: {
      source: {
        url: `${baseURL}/p/${collectionSlug}/report.html`,
        collection: collectionSlug,
        file: 'report.html',
      },
      destination: {
        url: `${baseURL}/p/${collectionSlug}/moved.html`,
        collection: collectionSlug,
        file: 'moved.html',
      },
      redirect: 'permanent',
      title: 'CLI Move',
      visibility: 'public',
    },
  })
  const redirected = await api.get(`/p/${collectionSlug}/report.html`, { maxRedirects: 0 })
  expect(redirected.status()).toBe(308)
  expect(redirected.headers().location).toBe(`/p/${collectionSlug}/moved.html`)

  const listed = jsonLine((await runPress(['list', collectionSlug, '--json'], env)).stdout) as {
    readonly data: { readonly pages: readonly { readonly file: string }[] }
  }
  expect(listed.data.pages.map((entry) => entry.file)).toContain('moved.html')
  expect(listed.data.pages.map((entry) => entry.file)).not.toContain('report.html')

  const movedWithoutRedirect = await runPress(
    ['move', `${collectionSlug}/moved.html`, `${collectionSlug}/final.html`, '--redirect', 'none'],
    env,
  )
  expect(movedWithoutRedirect.code).toBe(0)
  expect(movedWithoutRedirect.stdout).toContain(`${baseURL}/p/${collectionSlug}/moved.html`)
  expect(movedWithoutRedirect.stdout).toContain(`${baseURL}/p/${collectionSlug}/final.html`)
  expect(movedWithoutRedirect.stdout).toContain('redirect: none')
  expect((await api.get(`/p/${collectionSlug}/moved.html`)).status()).toBe(404)
  expect((await api.get(`/p/${collectionSlug}/final.html`)).status()).toBe(200)
  const originalAlias = await api.get(`/p/${collectionSlug}/report.html`, { maxRedirects: 0 })
  expect(originalAlias.status()).toBe(308)
  expect(originalAlias.headers().location).toBe(`/p/${collectionSlug}/final.html`)
})
