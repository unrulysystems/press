import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import type { APIRequestContext, APIResponse } from '@playwright/test'

import { findUserIdByEmail, mintApiTokenForUser } from '../apps/web/src/auth/apiTokens'
import { localnetUsers } from '../apps/web/src/auth/localnetFixtures'
import { closeDb, db } from '../apps/web/src/db/client'
import {
  findCollection,
  findMatchingAuditEvent,
  findPage,
  findTokenByUserAndName,
  installFailingAuditTrigger,
  removeFailingAuditTrigger,
} from '../apps/web/src/publish/e2eSupport'
import { newE2EAPIContext } from './api'

const runSlug = `pub-${Date.now().toString(36)}`

type SeedActor = {
  readonly id: string
  readonly token: string
}

const actors = {} as {
  owner: SeedActor
  secondUser: SeedActor
  admin: SeedActor
}

const servedPageHeaders = {
  'content-security-policy': 'sandbox allow-scripts allow-popups',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
} as const

function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...extra,
  }
}

function hashBody(body: string): string {
  return createHash('sha256').update(new TextEncoder().encode(body)).digest('hex')
}

function blobPath(collectionSlug: string, fileSlug: string): string {
  return join(storageDir(), collectionSlug, fileSlug)
}

function storageDir(): string {
  const value = process.env.PRESS_STORAGE_DIR
  if (!value) {
    throw new Error('PRESS_STORAGE_DIR missing from e2e environment')
  }
  return value
}

async function blobDirectoryEntries(collectionSlug: string): Promise<string[]> {
  try {
    return (await readdir(join(storageDir(), collectionSlug))).toSorted()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function signIn(
  baseURL: string | undefined,
  key: keyof typeof localnetUsers,
): Promise<APIRequestContext> {
  const context = await newE2EAPIContext({ baseURL })
  const response = await context.post('/api/auth/sign-in/email', {
    headers: { 'content-type': 'application/json' },
    data: {
      email: localnetUsers[key].email,
      password: localnetUsers[key].password,
      rememberMe: true,
    },
  })
  expect(response.status(), `sign-in ${localnetUsers[key].email}`).toBe(200)
  return context
}

async function expectServedOk(response: APIResponse): Promise<string> {
  expect(response.status()).toBe(200)
  const headers = response.headers()
  for (const [name, value] of Object.entries(servedPageHeaders)) {
    expect(headers[name], `${name} header`).toBe(value)
  }
  return await response.text()
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`press:${password}`).toString('base64')}`
}

async function expectAudit(input: {
  readonly collectionSlug: string
  readonly fileSlug?: string
  readonly action: 'publish' | 'overwrite' | 'unpublish' | 'visibility-change' | 'password-reroll'
  readonly userId: string
  readonly contentHash?: string
  readonly secretNotPresent?: string
}) {
  const matching = await findMatchingAuditEvent(db, {
    collectionSlug: input.collectionSlug,
    action: input.action,
    userId: input.userId,
    ...(input.fileSlug !== undefined ? { fileSlug: input.fileSlug } : {}),
    ...(input.contentHash !== undefined ? { contentHash: input.contentHash } : {}),
  })
  expect(matching, `${input.action} audit event should exist`).toBeDefined()
  if (input.secretNotPresent && matching) {
    expect(JSON.stringify(matching)).not.toContain(input.secretNotPresent)
  }
}

async function mintSeedActor(
  key: keyof typeof localnetUsers,
  tokenName: string,
): Promise<SeedActor> {
  const id = await findUserIdByEmail(db, localnetUsers[key].email)
  return {
    id,
    token: await mintApiTokenForUser(db, { userId: id, name: tokenName }),
  }
}

test.beforeAll(async () => {
  actors.owner = await mintSeedActor('owner', `${runSlug}-owner`)
  actors.secondUser = await mintSeedActor('secondUser', `${runSlug}-second`)
  actors.admin = await mintSeedActor('admin', `${runSlug}-admin`)
})

test.afterAll(async () => {
  await closeDb()
})

test('publish endpoint enforces bearer auth, validation, storage, overwrite, and audit', async ({
  baseURL,
}) => {
  const api = await newE2EAPIContext({ baseURL })
  const collectionSlug = `${runSlug}-main`
  const fileSlug = 'index.html'
  const body = '<!doctype html><title>Launch Report</title><h1>Launch</h1>'
  const expectedHash = hashBody(body)

  const cookieContext = await newE2EAPIContext({ baseURL })
  await cookieContext.post('/api/auth/sign-in/email', {
    headers: { 'content-type': 'application/json' },
    data: {
      email: localnetUsers.owner.email,
      password: localnetUsers.owner.password,
      rememberMe: true,
    },
  })
  const cookieOnly = await cookieContext.put(`/api/pages/${collectionSlug}/${fileSlug}`, {
    headers: { 'content-type': 'text/html' },
    data: body,
  })
  expect(cookieOnly.status()).toBe(401)

  for (const invalidFileSlug of ['a..b.html', '..%2Fevil.html', 'reports%2Fevil.html']) {
    const invalidSlug = await api.put(`/api/pages/${collectionSlug}/${invalidFileSlug}`, {
      headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
      data: body,
    })
    expect(invalidSlug.status(), `${invalidFileSlug} rejected`).toBe(400)
  }
  expect(await blobDirectoryEntries(collectionSlug)).toEqual([])
  for (const invalidFileSlug of ['a..b.html', '..%2Fevil.html', 'reports%2Fevil.html']) {
    const traversalServe = await api.get(`/p/${collectionSlug}/${invalidFileSlug}`)
    expect(traversalServe.status(), `${invalidFileSlug} not served`).toBe(404)
  }

  const invalidType = await api.put(`/api/pages/${collectionSlug}/wrong-type.html`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
    data: '{}',
  })
  expect(invalidType.status()).toBe(415)

  const tooLarge = await api.put(`/api/pages/${collectionSlug}/too-large.html`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: 'x'.repeat(Number(process.env.PRESS_MAX_UPLOAD_BYTES) + 1),
  })
  expect(tooLarge.status()).toBe(413)

  const published = await api.put(`/api/pages/${collectionSlug}/${fileSlug}?visibility=public`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: body,
  })
  expect(published.status()).toBe(200)
  expect(await published.json()).toEqual({
    url: `${baseURL}/p/${collectionSlug}/${fileSlug}`,
    collection: collectionSlug,
    file: fileSlug,
    title: 'Launch Report',
    visibility: 'public',
  })
  expect(await exists(blobPath(collectionSlug, fileSlug))).toBe(true)
  expect(await blobDirectoryEntries(collectionSlug)).toEqual([fileSlug])

  const storedCollection = await findCollection(db, collectionSlug)
  expect(storedCollection?.ownerId).toBe(actors.owner.id)
  const storedPage = await findPage(db, collectionSlug, fileSlug)
  expect(storedPage?.contentHash).toBe(expectedHash)
  await expectAudit({
    collectionSlug,
    fileSlug,
    action: 'publish',
    userId: actors.owner.id,
    contentHash: expectedHash,
  })

  const usedToken = await findTokenByUserAndName(db, actors.owner.id, `${runSlug}-owner`)
  expect(usedToken?.lastUsedAt).toBeInstanceOf(Date)

  const denied = await api.put(`/api/pages/${collectionSlug}/second.html`, {
    headers: authHeaders(actors.secondUser.token, { 'content-type': 'text/html' }),
    data: body,
  })
  expect(denied.status()).toBe(403)

  const overwriteBody = '<!doctype html><title>Updated Report</title><h1>Updated</h1>'
  const overwriteHash = hashBody(overwriteBody)
  const overwritten = await api.put(`/api/pages/${collectionSlug}/${fileSlug}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: overwriteBody,
  })
  expect(overwritten.status()).toBe(200)
  expect(await overwritten.json()).toMatchObject({
    collection: collectionSlug,
    file: fileSlug,
    title: 'Updated Report',
    visibility: 'public',
  })
  expect(await blobDirectoryEntries(collectionSlug)).toEqual([fileSlug])
  expect(await readFile(blobPath(collectionSlug, fileSlug), 'utf8')).toBe(overwriteBody)
  await expectAudit({
    collectionSlug,
    fileSlug,
    action: 'overwrite',
    userId: actors.owner.id,
    contentHash: overwriteHash,
  })
})

test('password publishing, patching, listing, reroll, and admin unpublish stay audited', async ({
  baseURL,
}) => {
  const api = await newE2EAPIContext({ baseURL })
  const collectionSlug = `${runSlug}-secure`
  const passwordFile = 'secret.html'
  const passwordBody = '<!doctype html><title>Secret</title>'
  const passwordHash = hashBody(passwordBody)

  const publishedPassword = await api.put(
    `/api/pages/${collectionSlug}/${passwordFile}?visibility=password`,
    {
      headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
      data: passwordBody,
    },
  )
  expect(publishedPassword.status()).toBe(200)
  const passwordResponse = await publishedPassword.json()
  expect(passwordResponse.password).toEqual(expect.any(String))
  expect(passwordResponse.visibility).toBe('password')

  const passwordPage = await findPage(db, collectionSlug, passwordFile)
  expect(passwordPage?.passwordHash).toEqual(expect.any(String))
  expect(passwordPage?.passwordHash).not.toBe(passwordResponse.password)
  await expectAudit({
    collectionSlug,
    fileSlug: passwordFile,
    action: 'publish',
    userId: actors.owner.id,
    contentHash: passwordHash,
    secretNotPresent: passwordResponse.password,
  })

  const patch = await api.patch(`/api/pages/${collectionSlug}/${passwordFile}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
    data: {
      visibility: null,
      allowlist: [localnetUsers.secondUser.email],
      title: 'Patched Secret',
    },
  })
  expect(patch.status()).toBe(200)
  expect(await patch.json()).toMatchObject({
    collection: collectionSlug,
    file: passwordFile,
    title: 'Patched Secret',
    visibility: 'default',
  })
  await expectAudit({
    collectionSlug,
    fileSlug: passwordFile,
    action: 'visibility-change',
    userId: actors.owner.id,
    contentHash: passwordHash,
  })

  const collectionPatch = await api.patch(`/api/collections/${collectionSlug}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
    data: { defaultVisibility: 'private', title: 'Secure Reports' },
  })
  expect(collectionPatch.status()).toBe(200)
  await expectAudit({
    collectionSlug,
    action: 'visibility-change',
    userId: actors.owner.id,
  })

  const rejectedPasswordDefault = await api.patch(`/api/collections/${collectionSlug}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
    data: { defaultVisibility: 'password' },
  })
  expect(rejectedPasswordDefault.status()).toBe(400)
  expect(await rejectedPasswordDefault.json()).toEqual({
    error:
      'defaultVisibility must be one of default, public, private; password is page-explicit only',
  })

  const inheritedPrivateFile = 'inherits-private.html'
  const inheritedPrivateBody = '<!doctype html><title>Inherited Private</title>'
  const inheritedPrivate = await api.put(`/api/pages/${collectionSlug}/${inheritedPrivateFile}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: inheritedPrivateBody,
  })
  expect(inheritedPrivate.status()).toBe(200)
  expect(await inheritedPrivate.json()).toMatchObject({ visibility: 'private' })
  await expectAudit({
    collectionSlug,
    fileSlug: inheritedPrivateFile,
    action: 'publish',
    userId: actors.owner.id,
    contentHash: hashBody(inheritedPrivateBody),
  })

  const publicDefaultsCollection = `${runSlug}-public-default`
  const publicSeedBody = '<!doctype html><title>Seed</title>'
  const publicSeed = await api.put(`/api/pages/${publicDefaultsCollection}/seed.html`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: publicSeedBody,
  })
  expect(publicSeed.status()).toBe(200)
  await expectAudit({
    collectionSlug: publicDefaultsCollection,
    fileSlug: 'seed.html',
    action: 'publish',
    userId: actors.owner.id,
    contentHash: hashBody(publicSeedBody),
  })
  const publicDefaultPatch = await api.patch(`/api/collections/${publicDefaultsCollection}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
    data: { defaultVisibility: 'public' },
  })
  expect(publicDefaultPatch.status()).toBe(200)
  await expectAudit({
    collectionSlug: publicDefaultsCollection,
    action: 'visibility-change',
    userId: actors.owner.id,
  })
  const inheritedPublicBody = '<!doctype html><title>Inherited Public</title>'
  const inheritedPublic = await api.put(`/api/pages/${publicDefaultsCollection}/inherited.html`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: inheritedPublicBody,
  })
  expect(inheritedPublic.status()).toBe(200)
  expect(await inheritedPublic.json()).toMatchObject({ visibility: 'public' })
  await expectAudit({
    collectionSlug: publicDefaultsCollection,
    fileSlug: 'inherited.html',
    action: 'publish',
    userId: actors.owner.id,
    contentHash: hashBody(inheritedPublicBody),
  })

  const defaultDefaultsCollection = `${runSlug}-default-default`
  const inheritedDefaultBody = '<!doctype html><title>Inherited Default</title>'
  const inheritedDefault = await api.put(`/api/pages/${defaultDefaultsCollection}/inherited.html`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: inheritedDefaultBody,
  })
  expect(inheritedDefault.status()).toBe(200)
  expect(await inheritedDefault.json()).toMatchObject({ visibility: 'default' })
  await expectAudit({
    collectionSlug: defaultDefaultsCollection,
    fileSlug: 'inherited.html',
    action: 'publish',
    userId: actors.owner.id,
    contentHash: hashBody(inheritedDefaultBody),
  })

  const privateFile = 'private.html'
  const privateBody = '<!doctype html><title>Private</title>'
  const privatePublish = await api.put(
    `/api/pages/${collectionSlug}/${privateFile}?visibility=private`,
    {
      headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
      data: privateBody,
    },
  )
  expect(privatePublish.status()).toBe(200)
  await expectAudit({
    collectionSlug,
    fileSlug: privateFile,
    action: 'publish',
    userId: actors.owner.id,
    contentHash: hashBody(privateBody),
  })
  const publicFile = 'public.html'
  const publicBody = '<!doctype html><title>Public</title>'
  const publicPublish = await api.put(
    `/api/pages/${collectionSlug}/${publicFile}?visibility=public`,
    {
      headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
      data: publicBody,
    },
  )
  expect(publicPublish.status()).toBe(200)
  await expectAudit({
    collectionSlug,
    fileSlug: publicFile,
    action: 'publish',
    userId: actors.owner.id,
    contentHash: hashBody(publicBody),
  })

  const secondPages = await api.get(`/api/collections/${collectionSlug}/pages`, {
    headers: authHeaders(actors.secondUser.token),
  })
  expect(secondPages.status()).toBe(200)
  const secondFiles = ((await secondPages.json()) as { pages: { file: string }[] }).pages.map(
    (entry) => entry.file,
  )
  expect(secondFiles).toContain(publicFile)
  expect(secondFiles).toContain(passwordFile)
  expect(secondFiles).not.toContain(privateFile)

  const secondCollections = await api.get('/api/collections', {
    headers: authHeaders(actors.secondUser.token),
  })
  expect(secondCollections.status()).toBe(200)
  expect(
    ((await secondCollections.json()) as { collections: { slug: string }[] }).collections.map(
      (entry) => entry.slug,
    ),
  ).toContain(collectionSlug)

  const deniedPatch = await api.patch(`/api/pages/${collectionSlug}/${passwordFile}`, {
    headers: authHeaders(actors.secondUser.token, { 'content-type': 'application/json' }),
    data: { title: 'Nope' },
  })
  expect(deniedPatch.status()).toBe(403)

  const reroll = await api.post(`/api/pages/${collectionSlug}/${passwordFile}/password`, {
    headers: authHeaders(actors.owner.token),
  })
  expect(reroll.status()).toBe(200)
  const rerollResponse = await reroll.json()
  expect(rerollResponse.password).toEqual(expect.any(String))
  expect(rerollResponse.password).not.toBe(passwordResponse.password)
  await expectAudit({
    collectionSlug,
    fileSlug: passwordFile,
    action: 'password-reroll',
    userId: actors.owner.id,
    contentHash: passwordHash,
    secretNotPresent: rerollResponse.password,
  })

  const adminDelete = await api.delete(`/api/pages/${collectionSlug}/${publicFile}`, {
    headers: authHeaders(actors.admin.token),
  })
  expect(adminDelete.status()).toBe(200)
  const archived = await findPage(db, collectionSlug, publicFile)
  expect(archived?.archivedAt).toBeInstanceOf(Date)
  expect(await exists(blobPath(collectionSlug, publicFile))).toBe(false)
  await expectAudit({
    collectionSlug,
    fileSlug: publicFile,
    action: 'unpublish',
    userId: actors.admin.id,
    contentHash: archived?.contentHash,
  })
})

test('Anonymous GET of a public page -> 200 with sandbox CSP', async ({
  baseURL,
  context,
  page: browserPage,
}) => {
  const api = await newE2EAPIContext({ baseURL })
  const collectionSlug = `${runSlug}-srv-public`
  const fileSlug = 'public.html'
  const body =
    '<!doctype html><title>Sandbox</title><body>public<script>document.body.dataset.cookie=document.cookie||"empty"</script></body>'
  const response = await api.put(`/api/pages/${collectionSlug}/${fileSlug}?visibility=public`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: body,
  })
  expect(response.status()).toBe(200)
  await expectAudit({
    collectionSlug,
    fileSlug,
    action: 'publish',
    userId: actors.owner.id,
    contentHash: hashBody(body),
  })

  const served = await api.get(`/p/${collectionSlug}/${fileSlug}`)
  expect(await expectServedOk(served)).toBe(body)

  if (!baseURL) {
    throw new Error('Playwright baseURL missing')
  }
  await context.addCookies([
    {
      name: 'press_e2e_cookie',
      value: 'leak-me',
      url: baseURL,
    },
  ])
  const browserResponse = await browserPage.goto(`/p/${collectionSlug}/${fileSlug}`)
  expect(browserResponse?.status()).toBe(200)
  for (const [name, value] of Object.entries(servedPageHeaders)) {
    expect(browserResponse?.headers()[name], `${name} browser header`).toBe(value)
  }
  await expect(browserPage.locator('body')).not.toHaveAttribute('data-cookie', /press_e2e_cookie/)
})

test('Anonymous browser GET of a default page -> 302 to /login; non-HTML -> 401', async ({
  baseURL,
}) => {
  const api = await newE2EAPIContext({ baseURL })
  const collectionSlug = `${runSlug}-srv-default-anon`
  const fileSlug = 'default.html'
  const body = '<!doctype html><title>Default</title>'
  const publish = await api.put(`/api/pages/${collectionSlug}/${fileSlug}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: body,
  })
  expect(publish.status()).toBe(200)
  await expectAudit({
    collectionSlug,
    fileSlug,
    action: 'publish',
    userId: actors.owner.id,
    contentHash: hashBody(body),
  })

  const browserGet = await api.get(`/p/${collectionSlug}/${fileSlug}`, {
    headers: { accept: 'text/html' },
    maxRedirects: 0,
  })
  expect(browserGet.status()).toBe(302)
  expect(browserGet.headers().location).toBe(`/login?next=%2Fp%2F${collectionSlug}%2F${fileSlug}`)

  const nonHtml = await api.get(`/p/${collectionSlug}/${fileSlug}`, {
    headers: { accept: 'application/json' },
  })
  expect(nonHtml.status()).toBe(401)
})

test('Authenticated wrong-domain user GET of a default page -> 403', async ({ baseURL }) => {
  const api = await newE2EAPIContext({ baseURL })
  const wrongDomain = await signIn(baseURL, 'wrongDomain')
  const collectionSlug = `${runSlug}-srv-wrong-domain`
  const fileSlug = 'default.html'
  const body = '<!doctype html><title>Default Forbidden</title>'
  const publish = await api.put(`/api/pages/${collectionSlug}/${fileSlug}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: body,
  })
  expect(publish.status()).toBe(200)
  await expectAudit({
    collectionSlug,
    fileSlug,
    action: 'publish',
    userId: actors.owner.id,
    contentHash: hashBody(body),
  })

  const served = await wrongDomain.get(`/p/${collectionSlug}/${fileSlug}`)
  expect(served.status()).toBe(403)
})

test('Authenticated allowed-domain user GET of a default page -> 200', async ({ baseURL }) => {
  const api = await newE2EAPIContext({ baseURL })
  const secondUser = await signIn(baseURL, 'secondUser')
  const collectionSlug = `${runSlug}-srv-domain`
  const fileSlug = 'default.html'
  const body = '<!doctype html><title>Default Allowed</title>'
  const publish = await api.put(`/api/pages/${collectionSlug}/${fileSlug}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: body,
  })
  expect(publish.status()).toBe(200)
  await expectAudit({
    collectionSlug,
    fileSlug,
    action: 'publish',
    userId: actors.owner.id,
    contentHash: hashBody(body),
  })

  const served = await secondUser.get(`/p/${collectionSlug}/${fileSlug}`)
  expect(await expectServedOk(served)).toBe(body)
})

test('private page: allowlisted external user -> 200; non-allowlisted same-domain -> 403; owner -> 200', async ({
  baseURL,
}) => {
  const api = await newE2EAPIContext({ baseURL })
  const external = await signIn(baseURL, 'external')
  const secondUser = await signIn(baseURL, 'secondUser')
  const owner = await signIn(baseURL, 'owner')
  const collectionSlug = `${runSlug}-srv-private`
  const fileSlug = 'private.html'
  const body = '<!doctype html><title>Private</title>'
  const publish = await api.put(
    `/api/pages/${collectionSlug}/${fileSlug}?visibility=private&allow=${encodeURIComponent(localnetUsers.external.email)}`,
    {
      headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
      data: body,
    },
  )
  expect(publish.status()).toBe(200)
  await expectAudit({
    collectionSlug,
    fileSlug,
    action: 'publish',
    userId: actors.owner.id,
    contentHash: hashBody(body),
  })

  expect(await expectServedOk(await external.get(`/p/${collectionSlug}/${fileSlug}`))).toBe(body)
  expect((await secondUser.get(`/p/${collectionSlug}/${fileSlug}`)).status()).toBe(403)
  expect(await expectServedOk(await owner.get(`/p/${collectionSlug}/${fileSlug}`))).toBe(body)
})

test('password page accepts independent Basic and owner session channels', async ({ baseURL }) => {
  const api = await newE2EAPIContext({ baseURL })
  const owner = await signIn(baseURL, 'owner')
  const wrongDomain = await signIn(baseURL, 'wrongDomain')
  const collectionSlug = `${runSlug}-srv-password`
  const fileSlug = 'password.html'
  const body = '<!doctype html><title>Password</title>'
  const publish = await api.put(`/api/pages/${collectionSlug}/${fileSlug}?visibility=password`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: body,
  })
  expect(publish.status()).toBe(200)
  const publishBody = (await publish.json()) as { password: string }
  await expectAudit({
    collectionSlug,
    fileSlug,
    action: 'publish',
    userId: actors.owner.id,
    contentHash: hashBody(body),
    secretNotPresent: publishBody.password,
  })

  const noCredentials = await api.get(`/p/${collectionSlug}/${fileSlug}`)
  expect(noCredentials.status()).toBe(401)
  expect(noCredentials.headers()['www-authenticate']).toBe('Basic realm="press"')

  const correctPassword = await api.get(`/p/${collectionSlug}/${fileSlug}`, {
    headers: { authorization: basicAuth(publishBody.password) },
  })
  expect(await expectServedOk(correctPassword)).toBe(body)

  const wrongPassword = await api.get(`/p/${collectionSlug}/${fileSlug}`, {
    headers: { authorization: basicAuth('wrong-password') },
  })
  expect(wrongPassword.status()).toBe(401)
  expect(wrongPassword.headers()['www-authenticate']).toBe('Basic realm="press"')

  const signedInCorrectPassword = await wrongDomain.get(`/p/${collectionSlug}/${fileSlug}`, {
    headers: { authorization: basicAuth(publishBody.password) },
  })
  expect(await expectServedOk(signedInCorrectPassword)).toBe(body)

  const signedInWrongPassword = await wrongDomain.get(`/p/${collectionSlug}/${fileSlug}`, {
    headers: { authorization: basicAuth('wrong-password') },
  })
  expect(signedInWrongPassword.status()).toBe(401)
  expect(signedInWrongPassword.headers()['www-authenticate']).toBe('Basic realm="press"')

  expect(await expectServedOk(await owner.get(`/p/${collectionSlug}/${fileSlug}`))).toBe(body)
  expect(
    await expectServedOk(
      await owner.get(`/p/${collectionSlug}/${fileSlug}`, {
        headers: { authorization: basicAuth('wrong-password') },
      }),
    ),
  ).toBe(body)
})

test('Unpublish via API archives; subsequent GET -> 404; ACL-filtered list endpoints no longer include it', async ({
  baseURL,
}) => {
  const api = await newE2EAPIContext({ baseURL })
  const collectionSlug = `${runSlug}-srv-unpublish`
  const fileSlug = 'gone.html'
  const body = '<!doctype html><title>Gone</title>'
  const publish = await api.put(`/api/pages/${collectionSlug}/${fileSlug}?visibility=public`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: body,
  })
  expect(publish.status()).toBe(200)
  await expectAudit({
    collectionSlug,
    fileSlug,
    action: 'publish',
    userId: actors.owner.id,
    contentHash: hashBody(body),
  })
  expect(await expectServedOk(await api.get(`/p/${collectionSlug}/${fileSlug}`))).toBe(body)

  const deleted = await api.delete(`/api/pages/${collectionSlug}/${fileSlug}`, {
    headers: authHeaders(actors.owner.token),
  })
  expect(deleted.status()).toBe(200)
  const archived = await findPage(db, collectionSlug, fileSlug)
  expect(archived?.archivedAt).toBeInstanceOf(Date)
  await expectAudit({
    collectionSlug,
    fileSlug,
    action: 'unpublish',
    userId: actors.owner.id,
    contentHash: hashBody(body),
  })

  expect((await api.get(`/p/${collectionSlug}/${fileSlug}`)).status()).toBe(404)

  const pages = await api.get(`/api/collections/${collectionSlug}/pages`, {
    headers: authHeaders(actors.owner.token),
  })
  expect(pages.status()).toBe(200)
  expect(
    ((await pages.json()) as { pages: { file: string }[] }).pages.map((entry) => entry.file),
  ).not.toContain(fileSlug)

  const collections = await api.get('/api/collections', {
    headers: authHeaders(actors.owner.token),
  })
  expect(collections.status()).toBe(200)
  expect(
    ((await collections.json()) as { collections: { slug: string }[] }).collections.map(
      (entry) => entry.slug,
    ),
  ).not.toContain(collectionSlug)
})

test('Boot with credential auth enabled in production -> refuses to start', async () => {
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn('bun', ['apps/web/src/setupServer.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PRESS_BASE_URL: 'https://press.example.test',
        PRESS_ALLOWED_DOMAINS: 'send.it',
        PRESS_ADMIN_EMAILS: 'admin@send.it',
        DATABASE_URL: 'postgres://press:press@127.0.0.1:1/press',
        PRESS_STORAGE_DIR: storageDir(),
        BETTER_AUTH_SECRET: 'localnet-secret-at-least-32-bytes',
        GOOGLE_CLIENT_ID: 'google-client-id',
        GOOGLE_CLIENT_SECRET: 'google-client-secret',
        PRESS_ENABLE_CREDENTIAL_AUTH: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let output = ''
    child.stderr.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        reject(new Error('server config probe unexpectedly exited 0'))
        return
      }
      resolve(output)
    })
  })

  expect(stderr).toContain('PRESS_ENABLE_CREDENTIAL_AUTH')
  expect(stderr).toContain('production')
})

test('transaction rollback restores the previous blob when audit insert fails', async ({
  baseURL,
}) => {
  const api = await newE2EAPIContext({ baseURL })
  const collectionSlug = `${runSlug}-rollback`
  const fileSlug = 'rollback.html'
  const originalBody = '<!doctype html><title>Original</title>'
  const original = await api.put(`/api/pages/${collectionSlug}/${fileSlug}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: originalBody,
  })
  expect(original.status()).toBe(200)
  expect(await blobDirectoryEntries(collectionSlug)).toEqual([fileSlug])
  await expectAudit({
    collectionSlug,
    fileSlug,
    action: 'publish',
    userId: actors.owner.id,
    contentHash: hashBody(originalBody),
  })

  const failingAuditTrigger = await installFailingAuditTrigger(db, collectionSlug)

  try {
    const rollbackBody = '<!doctype html><title>Rollback</title>'
    const response = await api.put(`/api/pages/${collectionSlug}/${fileSlug}`, {
      headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
      data: rollbackBody,
    })
    expect(response.status()).toBe(500)
    expect(await response.json()).toEqual({ error: 'internal server error' })
    expect(
      await findMatchingAuditEvent(db, {
        collectionSlug,
        fileSlug,
        action: 'overwrite',
        userId: actors.owner.id,
        contentHash: hashBody(rollbackBody),
      }),
    ).toBeUndefined()
  } finally {
    await removeFailingAuditTrigger(db, failingAuditTrigger)
  }

  expect(await blobDirectoryEntries(collectionSlug)).toEqual([fileSlug])
  expect(await readFile(blobPath(collectionSlug, fileSlug), 'utf8')).toBe(originalBody)
  expect((await findPage(db, collectionSlug, fileSlug))?.title).toBe('Original')
})
