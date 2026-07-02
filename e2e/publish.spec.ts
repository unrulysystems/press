import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, request as playwrightRequest, test } from '@playwright/test'

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
  const api = await playwrightRequest.newContext({ baseURL })
  const collectionSlug = `${runSlug}-main`
  const fileSlug = 'index.html'
  const body = '<!doctype html><title>Launch Report</title><h1>Launch</h1>'
  const expectedHash = hashBody(body)

  const cookieContext = await playwrightRequest.newContext({ baseURL })
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

  const invalidSlug = await api.put(`/api/pages/${collectionSlug}/a..b.html`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: body,
  })
  expect(invalidSlug.status()).toBe(400)
  expect(await exists(blobPath(collectionSlug, 'a..b.html'))).toBe(false)

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
  const api = await playwrightRequest.newContext({ baseURL })
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
  const inheritedPrivate = await api.put(`/api/pages/${collectionSlug}/${inheritedPrivateFile}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: '<!doctype html><title>Inherited Private</title>',
  })
  expect(inheritedPrivate.status()).toBe(200)
  expect(await inheritedPrivate.json()).toMatchObject({ visibility: 'private' })

  const publicDefaultsCollection = `${runSlug}-public-default`
  const publicSeed = await api.put(`/api/pages/${publicDefaultsCollection}/seed.html`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: '<!doctype html><title>Seed</title>',
  })
  expect(publicSeed.status()).toBe(200)
  const publicDefaultPatch = await api.patch(`/api/collections/${publicDefaultsCollection}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
    data: { defaultVisibility: 'public' },
  })
  expect(publicDefaultPatch.status()).toBe(200)
  const inheritedPublic = await api.put(`/api/pages/${publicDefaultsCollection}/inherited.html`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: '<!doctype html><title>Inherited Public</title>',
  })
  expect(inheritedPublic.status()).toBe(200)
  expect(await inheritedPublic.json()).toMatchObject({ visibility: 'public' })

  const defaultDefaultsCollection = `${runSlug}-default-default`
  const inheritedDefault = await api.put(`/api/pages/${defaultDefaultsCollection}/inherited.html`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: '<!doctype html><title>Inherited Default</title>',
  })
  expect(inheritedDefault.status()).toBe(200)
  expect(await inheritedDefault.json()).toMatchObject({ visibility: 'default' })

  const privateFile = 'private.html'
  await api.put(`/api/pages/${collectionSlug}/${privateFile}?visibility=private`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: '<!doctype html><title>Private</title>',
  })
  const publicFile = 'public.html'
  await api.put(`/api/pages/${collectionSlug}/${publicFile}?visibility=public`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: '<!doctype html><title>Public</title>',
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

test('transaction rollback restores the previous blob when audit insert fails', async ({
  baseURL,
}) => {
  const api = await playwrightRequest.newContext({ baseURL })
  const collectionSlug = `${runSlug}-rollback`
  const fileSlug = 'rollback.html'
  const originalBody = '<!doctype html><title>Original</title>'
  const original = await api.put(`/api/pages/${collectionSlug}/${fileSlug}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: originalBody,
  })
  expect(original.status()).toBe(200)
  expect(await blobDirectoryEntries(collectionSlug)).toEqual([fileSlug])

  await installFailingAuditTrigger(db, collectionSlug)

  try {
    const response = await api.put(`/api/pages/${collectionSlug}/${fileSlug}`, {
      headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
      data: '<!doctype html><title>Rollback</title>',
    })
    expect(response.status()).toBe(500)
  } finally {
    await removeFailingAuditTrigger(db)
  }

  expect(await blobDirectoryEntries(collectionSlug)).toEqual([fileSlug])
  expect(await readFile(blobPath(collectionSlug, fileSlug), 'utf8')).toBe(originalBody)
  expect((await findPage(db, collectionSlug, fileSlug))?.title).toBe('Original')
})
