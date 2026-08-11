import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { parseCollectionSlug, parseFileSlug } from '@press/core'

import type { APIRequestContext, APIResponse } from '@playwright/test'

import { findUserIdByEmail, mintApiTokenForUser } from '../apps/web/src/auth/apiTokens'
import { localnetDemoPages, localnetUsers } from '../apps/web/src/auth/localnetFixtures'
import { closeDb, db, pool } from '../apps/web/src/db/client'
import {
  findCollection,
  findMatchingAuditEvent,
  findPage,
  findPageRedirect,
  findTokenByUserAndName,
  installFailingAuditTrigger,
  removeFailingAuditTrigger,
} from '../apps/web/src/publish/e2eSupport'
import { moveBlob } from '../apps/web/src/publish/storage'
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

async function publishMoveFixture(input: {
  readonly api: APIRequestContext
  readonly token: string
  readonly collectionSlug: string
  readonly fileSlug: string
  readonly body: string
  readonly query?: string
}): Promise<void> {
  const response = await input.api.put(
    `/api/pages/${input.collectionSlug}/${input.fileSlug}${input.query ?? ''}`,
    {
      headers: authHeaders(input.token, { 'content-type': 'text/html' }),
      data: input.body,
    },
  )
  expect(response.status(), await response.text()).toBe(200)
}

async function raceMutationBehindCommittedPathMove(input: {
  readonly collectionSlug: string
  readonly sourceFile: string
  readonly destinationFile: string
  readonly mutate: () => Promise<APIResponse>
}): Promise<APIResponse> {
  const collectionSlug = parseCollectionSlug(input.collectionSlug)
  const sourceFile = parseFileSlug(input.sourceFile)
  const destinationFile = parseFileSlug(input.destinationFile)
  const connection = await pool.connect()
  let blobMove: Awaited<ReturnType<typeof moveBlob>> | undefined
  let mutationPromise: Promise<APIResponse> | undefined
  let pathLocked = false
  let transactionOpen = false
  let transactionCommitted = false

  try {
    const backend = await connection.query('select pg_backend_pid() as pid')
    const moverPid = Number(backend.rows[0]?.pid)
    if (!Number.isInteger(moverPid)) {
      throw new Error('move-race fixture could not resolve its PostgreSQL backend pid')
    }

    await connection.query('select pg_advisory_lock(hashtext($1), hashtext($2))', [
      collectionSlug,
      sourceFile,
    ])
    pathLocked = true
    await connection.query('begin')
    transactionOpen = true

    // Model the committed part of a move while retaining the source-path lock.
    // The competing request can still see the old MVCC row before it waits,
    // which is the precise stale-read window this regression guards.
    blobMove = await moveBlob(
      storageDir(),
      collectionSlug,
      sourceFile,
      collectionSlug,
      destinationFile,
    )
    const updated = await connection.query(
      'update "page" set "fileSlug" = $1, "updatedAt" = now() where "collectionSlug" = $2 and "fileSlug" = $3',
      [destinationFile, collectionSlug, sourceFile],
    )
    expect(updated.rowCount, 'move-race fixture should move exactly one page row').toBe(1)

    mutationPromise = input.mutate()
    await expect
      .poll(
        async () => {
          const waiting = await pool.query(
            'select count(*)::int as "waiterCount" from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))',
            [moverPid],
          )
          return Number(waiting.rows[0]?.waiterCount ?? 0)
        },
        {
          message: 'source mutation should wait behind the move path lock',
          timeout: 10_000,
        },
      )
      .toBeGreaterThan(0)

    await connection.query('commit')
    transactionOpen = false
    transactionCommitted = true
    await blobMove.commit()
    await connection.query('select pg_advisory_unlock(hashtext($1), hashtext($2))', [
      collectionSlug,
      sourceFile,
    ])
    pathLocked = false

    return await mutationPromise
  } catch (error) {
    if (transactionOpen) {
      await connection.query('rollback')
      transactionOpen = false
    }
    if (blobMove && !transactionCommitted) {
      await blobMove.rollback()
    }
    throw error
  } finally {
    if (pathLocked) {
      await connection.query('select pg_advisory_unlock(hashtext($1), hashtext($2))', [
        collectionSlug,
        sourceFile,
      ])
    }
    connection.release()
    if (!transactionCommitted && mutationPromise) {
      await mutationPromise.catch(() => undefined)
    }
  }
}

async function expectMovedSourceMutationNotFound(input: {
  readonly api: APIRequestContext
  readonly token: string
  readonly collectionSlug: string
  readonly sourceFile: string
  readonly destinationFile: string
  readonly title: string
  readonly auditAction: 'unpublish' | 'visibility-change' | 'password-reroll'
  readonly mutate: () => Promise<APIResponse>
}): Promise<void> {
  const body = `<!doctype html><title>${input.title}</title><p>stable race bytes</p>`
  await publishMoveFixture({
    api: input.api,
    token: input.token,
    collectionSlug: input.collectionSlug,
    fileSlug: input.sourceFile,
    body,
    query: '?visibility=public',
  })
  const sourceBefore = await findPage(db, input.collectionSlug, input.sourceFile)

  const response = await raceMutationBehindCommittedPathMove({
    collectionSlug: input.collectionSlug,
    sourceFile: input.sourceFile,
    destinationFile: input.destinationFile,
    mutate: input.mutate,
  })
  const responseText = await response.text()
  expect(response.status(), `${input.auditAction}: ${responseText}`).toBe(404)
  expect(JSON.parse(responseText)).toEqual({ error: 'page not found' })

  expect(await findPage(db, input.collectionSlug, input.sourceFile)).toBeUndefined()
  expect(await findPage(db, input.collectionSlug, input.destinationFile)).toMatchObject({
    id: sourceBefore?.id,
    title: input.title,
    archivedAt: null,
    passwordHash: null,
  })
  expect(await exists(blobPath(input.collectionSlug, input.sourceFile))).toBe(false)
  expect(await readFile(blobPath(input.collectionSlug, input.destinationFile), 'utf8')).toBe(body)
  expect(
    await findMatchingAuditEvent(db, {
      collectionSlug: input.collectionSlug,
      fileSlug: input.sourceFile,
      action: input.auditAction,
      userId: actors.owner.id,
    }),
  ).toBeUndefined()
}

async function runLocalnetSeed(): Promise<{ readonly code: number; readonly stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn('nub', ['run', '--filter', '@press/web', 'db:seed'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      resolve({ code: code ?? 1, stderr })
    })
  })
}

async function expectPermanentPageRedirect(
  api: APIRequestContext,
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const response = await api.get(sourcePath, { maxRedirects: 0 })
  expect(response.status()).toBe(308)
  expect(response.headers().location).toBe(destinationPath)
  for (const [name, value] of Object.entries(servedPageHeaders)) {
    expect(response.headers()[name], `${name} redirect header`).toBe(value)
  }
  expect(await response.text()).toBe('')
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

test('password gate: branded HTML entry, form+cookie unlock, Basic for programmatic (F1)', async ({
  baseURL,
  page,
}) => {
  if (!baseURL) {
    throw new Error('Playwright baseURL missing')
  }
  const api = await newE2EAPIContext({ baseURL })
  const collectionSlug = `${runSlug}-gate`
  const file = 'locked.html'
  const secret = 'liberty-1776'
  const bodyMarker = 'TOP-SECRET-DECLARATION-BODY'

  // publish a password page with a known custom password (via the M2 header)
  const published = await api.put(`/api/pages/${collectionSlug}/${file}?visibility=password`, {
    headers: authHeaders(actors.owner.token, {
      'content-type': 'text/html',
      'x-press-page-password': secret,
    }),
    data: `<!doctype html><title>Locked Report</title><article>${bodyMarker}</article>`,
  })
  expect(published.status()).toBe(200)
  const path = `/p/${collectionSlug}/${file}`

  // 1. HTML reader with no credential → branded gate (200), no body leak, form-capable CSP
  const gate = await api.get(path, { headers: { accept: 'text/html' } })
  expect(gate.status()).toBe(200)
  const gateHtml = await gate.text()
  expect(gateHtml).toContain('name="password"')
  expect(gateHtml).not.toContain(bodyMarker)
  expect(gate.headers()['content-security-policy']).toContain("form-action 'self'")

  // 2. programmatic (non-HTML) reader → Basic challenge, not the branded page
  const programmatic = await api.get(path, { headers: { accept: 'application/json' } })
  expect(programmatic.status()).toBe(401)
  expect(programmatic.headers()['www-authenticate']).toBe('Basic realm="press"')

  // 3. Basic auth with the password still works (programmatic channel retained)
  const basic = await api.get(path, {
    headers: { authorization: `Basic ${Buffer.from(`:${secret}`).toString('base64')}` },
  })
  expect(basic.status()).toBe(200)
  expect(await basic.text()).toContain(bodyMarker)

  // 4. wrong password POST → 401 gate with an error, no body leak
  const wrong = await api.post(path, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: 'password=not-the-password',
  })
  expect(wrong.status()).toBe(401)
  const wrongHtml = await wrong.text()
  expect(wrongHtml).toContain('Incorrect')
  expect(wrongHtml).not.toContain(bodyMarker)

  // 4b. the unlock 303 is a /p/ response that is not the entry page → it carries the
  // sandbox CSP + security headers (INV-2 / REQ-SRV-002), plus Location and the cookie
  const unlock303 = await api.post(path, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: `password=${secret}`,
    maxRedirects: 0,
  })
  expect(unlock303.status()).toBe(303)
  expect(unlock303.headers()['content-security-policy']).toContain('sandbox')
  expect(unlock303.headers()['x-content-type-options']).toBe('nosniff')
  expect(unlock303.headers()['referrer-policy']).toBe('no-referrer')
  expect(unlock303.headers()['set-cookie']).toContain('press_pw_')

  // 5. real browser: gate renders, form submits under the CSP, cookie unlocks the report
  await page.goto(path)
  await expect(page.locator('input[name="password"]')).toBeVisible()
  await page.fill('input[name="password"]', secret)
  await page.click('button[type="submit"]')
  await expect(page.locator('body')).toContainText(bodyMarker)
})

test('malformed percent-encoding in mutation paths returns 400, not 500 (M-2)', async ({
  baseURL,
}) => {
  const api = await newE2EAPIContext({ baseURL })
  // %E0%A4%A is a truncated UTF-8 sequence: it is syntactically valid
  // percent-encoding (so it survives URL parsing) but decodeURIComponent rejects
  // it. The mutation API must answer 400, never a 500.
  const paths = [
    `/api/pages/%E0%A4%A/thing.html`,
    `/api/collections/%E0%A4%A`,
    `/api/collections/%E0%A4%A/pages`,
    `/api/pages/coll/%E0%A4%A`,
  ]
  const bodies = [
    { method: 'PUT', data: '<!doctype html><title>x</title>' },
    { method: 'PATCH', data: { visibility: 'public' } },
    { method: 'GET' },
    { method: 'PATCH', data: { title: 'x' } },
  ]
  for (let index = 0; index < paths.length; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each path is a distinct request
    const response = await (
      api as unknown as Record<string, (url: string, init: object) => Promise<APIResponse>>
    )[bodies[index].method.toLowerCase()](paths[index], {
      ...(bodies[index].method === 'PUT'
        ? { headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }) }
        : bodies[index].method === 'PATCH'
          ? { headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }) }
          : { headers: authHeaders(actors.owner.token) }),
      ...(bodies[index].data !== undefined ? { data: bodies[index].data } : {}),
    })
    expect(response.status(), await response.text()).toBe(400)
  }
})

test('anonymous endpoint bodies are byte-capped (M-3)', async ({ baseURL }) => {
  const api = await newE2EAPIContext({ baseURL })
  // /api/cli/exchange is unauthenticated: an oversized JSON body must 413 before
  // any buffering or code/verifier validation (no memory-exhaustion vector).
  const exchange = await api.post('/api/cli/exchange', {
    headers: { 'content-type': 'application/json' },
    data: '{"padding":"' + 'a'.repeat(9_000) + '"}',
  })
  expect(exchange.status()).toBe(413)

  // The password-gate form target is public; its POST body must also be capped.
  const collectionSlug = `${runSlug}-body-caps`
  const file = 'locked.html'
  await api.put(`/api/pages/${collectionSlug}/${file}?visibility=password`, {
    headers: authHeaders(actors.owner.token, {
      'content-type': 'text/html',
      'x-press-page-password': 'cap-secret-1234',
    }),
    data: '<!doctype html><title>Cap</title>',
  })
  const unlock = await api.post(`/p/${collectionSlug}/${file}`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: 'password=' + 'a'.repeat(20_000),
  })
  expect(unlock.status()).toBe(413)
})

test('password reroll invalidates a previously issued unlock cookie (F-15/19)', async ({
  baseURL,
  page,
}) => {
  if (!baseURL) {
    throw new Error('Playwright baseURL missing')
  }
  const api = await newE2EAPIContext({ baseURL })
  const collectionSlug = `${runSlug}-gate-reroll`
  const file = 'locked.html'
  const firstSecret = 'first-secret-1234'
  const bodyMarker = 'REPORT-BODY-AFTER-REROLL'

  const published = await api.put(`/api/pages/${collectionSlug}/${file}?visibility=password`, {
    headers: authHeaders(actors.owner.token, {
      'content-type': 'text/html',
      'x-press-page-password': firstSecret,
    }),
    data: `<!doctype html><title>Reroll</title><article>${bodyMarker}</article>`,
  })
  expect(published.status()).toBe(200)
  const path = `/p/${collectionSlug}/${file}`

  // Unlock in a real browser: the gate posts the password, the 303 sets the
  // page-scoped unlock cookie, and the report renders.
  await page.goto(path)
  await page.fill('input[name="password"]', firstSecret)
  await page.click('button[type="submit"]')
  await expect(page.locator('body')).toContainText(bodyMarker)

  // Owner rerolls the password; the plaintext hash changes but the page id stays.
  const reroll = await api.post(`/api/pages/${collectionSlug}/${file}/password`, {
    headers: authHeaders(actors.owner.token),
  })
  expect(reroll.status()).toBe(200)
  const rerollBody = (await reroll.json()) as { password: string }

  // The same browser still holds the old unlock cookie. It must no longer open
  // the page: the gate reappears and the report body is not served.
  await page.goto(path)
  await expect(page.locator('input[name="password"]')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(bodyMarker)

  // The new password unlocks normally.
  await page.fill('input[name="password"]', rerollBody.password)
  await page.click('button[type="submit"]')
  await expect(page.locator('body')).toContainText(bodyMarker)
})

test('page move preserves identity and ACL while permanent redirects track the canonical path', async ({
  baseURL,
}) => {
  if (!baseURL) {
    throw new Error('Playwright baseURL missing')
  }
  const api = await newE2EAPIContext({ baseURL })
  const external = await signIn(baseURL, 'external')
  const sourceCollection = `${runSlug}-move-source`
  const destinationCollection = `${runSlug}-move-destination`
  const finalCollection = `${runSlug}-move-final`
  const sourceFile = 'old.html'
  const destinationFile = 'new.html'
  const finalFile = 'final.html'
  const body = '<!doctype html><title>Move Contract</title><main>stable move bytes</main>'
  const bodyHash = hashBody(body)

  await publishMoveFixture({
    api,
    token: actors.owner.token,
    collectionSlug: sourceCollection,
    fileSlug: sourceFile,
    body,
    query: `?allow=${encodeURIComponent(localnetUsers.external.email)}`,
  })
  const collectionPatch = await api.patch(`/api/collections/${sourceCollection}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
    data: { defaultVisibility: 'private' },
  })
  expect(collectionPatch.status()).toBe(200)

  const sourceBefore = await findPage(db, sourceCollection, sourceFile)
  expect(sourceBefore?.visibility).toBeNull()
  const sourcePublishedAt = sourceBefore?.publishedAt.toISOString()

  const moved = await api.post(`/api/pages/${sourceCollection}/${sourceFile}/move`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
    data: { collection: destinationCollection, file: destinationFile },
  })
  expect(moved.status()).toBe(200)
  expect(await moved.json()).toEqual({
    source: {
      url: `${baseURL}/p/${sourceCollection}/${sourceFile}`,
      collection: sourceCollection,
      file: sourceFile,
    },
    destination: {
      url: `${baseURL}/p/${destinationCollection}/${destinationFile}`,
      collection: destinationCollection,
      file: destinationFile,
    },
    redirect: 'permanent',
    title: 'Move Contract',
    visibility: 'private',
  })
  const moveAudit = await findMatchingAuditEvent(db, {
    collectionSlug: sourceCollection,
    fileSlug: sourceFile,
    action: 'move',
    userId: actors.owner.id,
    contentHash: bodyHash,
  })
  expect(moveAudit?.details).toEqual({
    kind: 'move',
    source: { collection: sourceCollection, file: sourceFile },
    destination: { collection: destinationCollection, file: destinationFile },
    redirect: 'permanent',
  })

  const destination = await findPage(db, destinationCollection, destinationFile)
  expect(destination).toMatchObject({
    id: sourceBefore?.id,
    visibility: 'private',
    contentHash: bodyHash,
    allowlist: [localnetUsers.external.email],
  })
  expect(destination?.publishedAt.toISOString()).toBe(sourcePublishedAt)
  expect(await exists(blobPath(sourceCollection, sourceFile))).toBe(false)
  expect(await readFile(blobPath(destinationCollection, destinationFile), 'utf8')).toBe(body)
  await expectPermanentPageRedirect(
    api,
    `/p/${sourceCollection}/${sourceFile}`,
    `/p/${destinationCollection}/${destinationFile}`,
  )
  expect(
    await expectServedOk(
      await external.get(`/p/${destinationCollection}/${destinationFile}`, {
        headers: { accept: 'text/html' },
      }),
    ),
  ).toBe(body)

  const sourceList = await api.get(`/api/collections/${sourceCollection}/pages`, {
    headers: authHeaders(actors.owner.token),
  })
  expect((await sourceList.json()).pages).toEqual([])
  const destinationList = await api.get(`/api/collections/${destinationCollection}/pages`, {
    headers: authHeaders(actors.owner.token),
  })
  expect(await destinationList.json()).toMatchObject({
    pages: [expect.objectContaining({ collection: destinationCollection, file: destinationFile })],
  })

  const movedAgain = await api.post(`/api/pages/${destinationCollection}/${destinationFile}/move`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
    data: { collection: finalCollection, file: finalFile, redirect: 'permanent' },
  })
  expect(movedAgain.status()).toBe(200)
  await expectPermanentPageRedirect(
    api,
    `/p/${sourceCollection}/${sourceFile}`,
    `/p/${finalCollection}/${finalFile}`,
  )
  await expectPermanentPageRedirect(
    api,
    `/p/${destinationCollection}/${destinationFile}`,
    `/p/${finalCollection}/${finalFile}`,
  )

  const movedBack = await api.post(`/api/pages/${finalCollection}/${finalFile}/move`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
    data: { collection: sourceCollection, file: sourceFile, redirect: 'none' },
  })
  expect(movedBack.status()).toBe(200)
  expect(
    await expectServedOk(
      await external.get(`/p/${sourceCollection}/${sourceFile}`, {
        headers: { accept: 'text/html' },
      }),
    ),
  ).toBe(body)
  expect((await api.get(`/p/${finalCollection}/${finalFile}`)).status()).toBe(404)
  await expectPermanentPageRedirect(
    api,
    `/p/${destinationCollection}/${destinationFile}`,
    `/p/${sourceCollection}/${sourceFile}`,
  )

  const unpublished = await api.delete(`/api/pages/${sourceCollection}/${sourceFile}`, {
    headers: authHeaders(actors.owner.token),
  })
  expect(unpublished.status()).toBe(200)
  expect((await api.get(`/p/${sourceCollection}/${sourceFile}`)).status()).toBe(404)
  expect((await api.get(`/p/${destinationCollection}/${destinationFile}`)).status()).toBe(404)
})

test('page mutations re-read their source after a concurrent move wins the path lock', async ({
  baseURL,
}) => {
  const api = await newE2EAPIContext({ baseURL })
  const collectionSlug = `${runSlug}-move-mutation-race`

  await expectMovedSourceMutationNotFound({
    api,
    token: actors.owner.token,
    collectionSlug,
    sourceFile: 'patch-source.html',
    destinationFile: 'patch-destination.html',
    title: 'Patch Race',
    auditAction: 'visibility-change',
    mutate: async () =>
      await api.patch(`/api/pages/${collectionSlug}/patch-source.html`, {
        headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
        data: { title: 'Must Not Apply' },
      }),
  })

  await expectMovedSourceMutationNotFound({
    api,
    token: actors.owner.token,
    collectionSlug,
    sourceFile: 'password-source.html',
    destinationFile: 'password-destination.html',
    title: 'Password Race',
    auditAction: 'password-reroll',
    mutate: async () =>
      await api.post(`/api/pages/${collectionSlug}/password-source.html/password`, {
        headers: authHeaders(actors.owner.token),
      }),
  })

  await expectMovedSourceMutationNotFound({
    api,
    token: actors.owner.token,
    collectionSlug,
    sourceFile: 'delete-source.html',
    destinationFile: 'delete-destination.html',
    title: 'Delete Race',
    auditAction: 'unpublish',
    mutate: async () =>
      await api.delete(`/api/pages/${collectionSlug}/delete-source.html`, {
        headers: authHeaders(actors.owner.token),
      }),
  })
})

test('page move rejects collisions and non-owners, reclaims archives, and rolls storage back', async ({
  baseURL,
}) => {
  const api = await newE2EAPIContext({ baseURL })
  const collectionSlug = `${runSlug}-move-guards`
  const sourceFile = 'source.html'
  const liveDestination = 'occupied.html'
  const sourceBody = '<!doctype html><title>Source</title><p>source stays safe</p>'
  const destinationBody = '<!doctype html><title>Occupied</title><p>occupied stays safe</p>'

  await publishMoveFixture({
    api,
    token: actors.owner.token,
    collectionSlug,
    fileSlug: sourceFile,
    body: sourceBody,
    query: '?visibility=public',
  })

  for (const data of [
    { collection: '../bad', file: 'new.html' },
    { collection: collectionSlug, file: 'bad..name.html' },
    { collection: collectionSlug, file: 'new.html', redirect: 'temporary' },
    { collection: collectionSlug, file: sourceFile },
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Each invalid request must observe unchanged source state.
    const invalid = await api.post(`/api/pages/${collectionSlug}/${sourceFile}/move`, {
      headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
      data,
    })
    expect(invalid.status()).toBe(400)
  }
  expect(await readFile(blobPath(collectionSlug, sourceFile), 'utf8')).toBe(sourceBody)

  const otherOwnerCollection = `${runSlug}-other-owner-destination`
  await publishMoveFixture({
    api,
    token: actors.secondUser.token,
    collectionSlug: otherOwnerCollection,
    fileSlug: 'owned.html',
    body: '<!doctype html><title>Other owner collection</title>',
    query: '?visibility=public',
  })
  const crossOwnerDestination = await api.post(`/api/pages/${collectionSlug}/${sourceFile}/move`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
    data: { collection: otherOwnerCollection, file: 'new.html' },
  })
  expect(crossOwnerDestination.status()).toBe(403)
  expect(await readFile(blobPath(collectionSlug, sourceFile), 'utf8')).toBe(sourceBody)
  await publishMoveFixture({
    api,
    token: actors.owner.token,
    collectionSlug,
    fileSlug: liveDestination,
    body: destinationBody,
    query: '?visibility=public',
  })

  const liveCollision = await api.post(`/api/pages/${collectionSlug}/${sourceFile}/move`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
    data: { collection: collectionSlug, file: liveDestination },
  })
  expect(liveCollision.status()).toBe(409)
  expect(await readFile(blobPath(collectionSlug, sourceFile), 'utf8')).toBe(sourceBody)
  expect(await readFile(blobPath(collectionSlug, liveDestination), 'utf8')).toBe(destinationBody)

  for (const actor of [actors.secondUser, actors.admin]) {
    // oxlint-disable-next-line no-await-in-loop -- Authorization actors are asserted independently.
    const forbidden = await api.post(`/api/pages/${collectionSlug}/${sourceFile}/move`, {
      headers: authHeaders(actor.token, { 'content-type': 'application/json' }),
      data: { collection: `${runSlug}-forbidden-destination`, file: 'new.html' },
    })
    expect(forbidden.status()).toBe(403)
  }

  const aliasSource = 'alias-source.html'
  const aliasTarget = 'alias-target.html'
  const challenger = 'challenger.html'
  await publishMoveFixture({
    api,
    token: actors.owner.token,
    collectionSlug,
    fileSlug: aliasSource,
    body: '<!doctype html><title>Alias owner</title>',
    query: '?visibility=public',
  })
  expect(
    (
      await api.post(`/api/pages/${collectionSlug}/${aliasSource}/move`, {
        headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
        data: { collection: collectionSlug, file: aliasTarget },
      })
    ).status(),
  ).toBe(200)
  await publishMoveFixture({
    api,
    token: actors.owner.token,
    collectionSlug,
    fileSlug: challenger,
    body: '<!doctype html><title>Challenger</title>',
    query: '?visibility=public',
  })
  const redirectCollision = await api.post(`/api/pages/${collectionSlug}/${challenger}/move`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
    data: { collection: collectionSlug, file: aliasSource },
  })
  expect(redirectCollision.status()).toBe(409)
  expect((await api.get(`/p/${collectionSlug}/${challenger}`)).status()).toBe(200)
  const publishOverRedirect = await api.put(`/api/pages/${collectionSlug}/${aliasSource}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: '<!doctype html><title>Must not shadow redirect</title>',
  })
  expect(publishOverRedirect.status()).toBe(409)
  await expectPermanentPageRedirect(
    api,
    `/p/${collectionSlug}/${aliasSource}`,
    `/p/${collectionSlug}/${aliasTarget}`,
  )

  const archivedDestination = 'archived.html'
  await publishMoveFixture({
    api,
    token: actors.owner.token,
    collectionSlug,
    fileSlug: archivedDestination,
    body: '<!doctype html><title>Archived destination</title>',
    query: '?visibility=public',
  })
  expect(
    (
      await api.delete(`/api/pages/${collectionSlug}/${archivedDestination}`, {
        headers: authHeaders(actors.owner.token),
      })
    ).status(),
  ).toBe(200)
  const sourceBeforeReclaim = await findPage(db, collectionSlug, sourceFile)
  const reclaimed = await api.post(`/api/pages/${collectionSlug}/${sourceFile}/move`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
    data: { collection: collectionSlug, file: archivedDestination, redirect: 'none' },
  })
  expect(reclaimed.status()).toBe(200)
  expect((await findPage(db, collectionSlug, archivedDestination))?.id).toBe(
    sourceBeforeReclaim?.id,
  )
  expect((await api.get(`/p/${collectionSlug}/${sourceFile}`)).status()).toBe(404)

  const rollbackCollection = `${runSlug}-move-rollback`
  const rollbackSource = 'rollback-source.html'
  const rollbackDestination = 'rollback-destination.html'
  const rollbackBody = '<!doctype html><title>Rollback</title><p>must survive</p>'
  await publishMoveFixture({
    api,
    token: actors.owner.token,
    collectionSlug: rollbackCollection,
    fileSlug: rollbackSource,
    body: rollbackBody,
    query: '?visibility=public',
  })
  const trigger = await installFailingAuditTrigger(db, rollbackCollection)
  try {
    const failed = await api.post(`/api/pages/${rollbackCollection}/${rollbackSource}/move`, {
      headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
      data: { collection: rollbackCollection, file: rollbackDestination },
    })
    expect(failed.status()).toBe(500)
  } finally {
    await removeFailingAuditTrigger(db, trigger)
  }
  expect(await readFile(blobPath(rollbackCollection, rollbackSource), 'utf8')).toBe(rollbackBody)
  expect(await exists(blobPath(rollbackCollection, rollbackDestination))).toBe(false)
  expect(await findPage(db, rollbackCollection, rollbackSource)).toMatchObject({
    contentHash: hashBody(rollbackBody),
    archivedAt: null,
  })
  expect(await findPage(db, rollbackCollection, rollbackDestination)).toBeUndefined()
})

test('localnet seeding restores a moved demo page without stale redirects or blobs', async ({
  baseURL,
}) => {
  const api = await newE2EAPIContext({ baseURL })
  const demoPage = localnetDemoPages[0]
  if (!demoPage) {
    throw new Error('localnet demo page fixture missing')
  }
  const destinationCollection = `${runSlug}-moved-seed`
  const destinationFile = 'moved-demo.html'
  const pageBefore = await findPage(db, demoPage.collectionSlug, demoPage.fileSlug)
  expect(pageBefore?.id).toBe(`demo-${demoPage.collectionSlug}-${demoPage.fileSlug}`)

  const moved = await api.post(`/api/pages/${demoPage.collectionSlug}/${demoPage.fileSlug}/move`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'application/json' }),
    data: { collection: destinationCollection, file: destinationFile },
  })
  expect(moved.status(), await moved.text()).toBe(200)
  expect(await exists(blobPath(demoPage.collectionSlug, demoPage.fileSlug))).toBe(false)
  expect(await exists(blobPath(destinationCollection, destinationFile))).toBe(true)

  const seed = await runLocalnetSeed()
  expect(seed.code, seed.stderr).toBe(0)

  const restoredPage = await findPage(db, demoPage.collectionSlug, demoPage.fileSlug)
  expect(restoredPage).toMatchObject({
    id: pageBefore?.id,
    archivedAt: null,
  })
  expect(await findPage(db, destinationCollection, destinationFile)).toBeUndefined()
  expect(await exists(blobPath(demoPage.collectionSlug, demoPage.fileSlug))).toBe(true)
  const restoredBody = await readFile(blobPath(demoPage.collectionSlug, demoPage.fileSlug), 'utf8')
  expect(restoredBody).toContain(`<title>${demoPage.title}</title>`)
  expect(hashBody(restoredBody)).toBe(restoredPage?.contentHash)
  expect(await exists(blobPath(destinationCollection, destinationFile))).toBe(false)
  expect(await findPageRedirect(db, demoPage.collectionSlug, demoPage.fileSlug)).toBeUndefined()
})
test('republish after unpublish starts neutral — stale ACL and password never resurrect (F-18)', async ({
  baseURL,
}) => {
  const api = await newE2EAPIContext({ baseURL })
  const owner = await signIn(baseURL, 'owner')
  const collectionSlug = `${runSlug}-republish-neutral`
  const lockedFile = 'locked.html'
  const body = '<!doctype html><title>Locked</title>'
  const publish = await api.put(`/api/pages/${collectionSlug}/${lockedFile}?visibility=password`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: body,
  })
  expect(publish.status()).toBe(200)
  const publishBody = (await publish.json()) as { password: string; visibility: string }
  expect(publishBody.visibility).toBe('password')
  expect(
    await expectServedOk(
      await api.get(`/p/${collectionSlug}/${lockedFile}`, {
        headers: { authorization: basicAuth(publishBody.password) },
      }),
    ),
  ).toBe(body)

  expect(
    (
      await api.delete(`/api/pages/${collectionSlug}/${lockedFile}`, {
        headers: authHeaders(actors.owner.token),
      })
    ).status(),
  ).toBe(200)

  const republishedBody = '<!doctype html><title>Replaced content</title>'
  const republish = await api.put(`/api/pages/${collectionSlug}/${lockedFile}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: republishedBody,
  })
  expect(republish.status(), await republish.text()).toBe(200)
  const republishBody = (await republish.json()) as {
    readonly visibility: string
    readonly password?: string
    readonly allow?: readonly string[]
  }
  // A fresh publish: neutral page state, resolved through the collection default.
  expect(republishBody.visibility).toBe('default')
  expect(republishBody.password).toBeUndefined()
  expect(republishBody.allow).toBeUndefined()

  const row = await findPage(db, collectionSlug, lockedFile)
  expect(row).toMatchObject({ visibility: null, passwordHash: null, allowlist: [] })
  expect(row?.archivedAt).toBeNull()

  // The stale password channel is gone: no hash, so the old password must not unlock.
  const oldPasswordAttempt = await api.get(`/p/${collectionSlug}/${lockedFile}`, {
    headers: { authorization: basicAuth(publishBody.password) },
  })
  expect(oldPasswordAttempt.status()).toBe(401)
  expect(await expectServedOk(await owner.get(`/p/${collectionSlug}/${lockedFile}`))).toBe(
    republishedBody,
  )

  // Same neutrality for a private page: the archived allowlist must not resurrect.
  const privateFile = 'private-allow.html'
  const privatePublish = await api.put(
    `/api/pages/${collectionSlug}/${privateFile}?visibility=private&allow=bob%40example.test`,
    {
      headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
      data: '<!doctype html><title>Private</title>',
    },
  )
  expect(privatePublish.status()).toBe(200)
  expect((await findPage(db, collectionSlug, privateFile))?.allowlist).toEqual(['bob@example.test'])
  expect(
    (
      await api.delete(`/api/pages/${collectionSlug}/${privateFile}`, {
        headers: authHeaders(actors.owner.token),
      })
    ).status(),
  ).toBe(200)
  const privateRepublish = await api.put(`/api/pages/${collectionSlug}/${privateFile}`, {
    headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
    data: '<!doctype html><title>Private replaced</title>',
  })
  expect(privateRepublish.status(), await privateRepublish.text()).toBe(200)
  const privateBody = (await privateRepublish.json()) as {
    readonly visibility: string
    readonly allow?: readonly string[]
  }
  expect(privateBody.visibility).toBe('default')
  expect(privateBody.allow).toBeUndefined()
  expect(await findPage(db, collectionSlug, privateFile)).toMatchObject({
    visibility: null,
    passwordHash: null,
    allowlist: [],
  })
})

test('concurrent first publishes to a brand-new collection never 500 (M-1)', async ({
  baseURL,
}) => {
  const api = await newE2EAPIContext({ baseURL })
  // The race window is between each transaction's collection findFirst and its
  // insert. Firing both PUTs concurrently across several brand-new collections
  // forces the interleave often enough to make the pre-fix unique-violation 500
  // observable; the hard invariant this guards is "never 500", which the fixed
  // onConflictDoNothing + re-read makes deterministic for any interleave.
  for (let round = 0; round < 4; round += 1) {
    const collectionSlug = `${runSlug}-first-publish-race-${round}`
    const [first, second] = await Promise.all([
      api.put(`/api/pages/${collectionSlug}/a.html`, {
        headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
        data: '<!doctype html><title>A</title>',
      }),
      api.put(`/api/pages/${collectionSlug}/b.html`, {
        headers: authHeaders(actors.owner.token, { 'content-type': 'text/html' }),
        data: '<!doctype html><title>B</title>',
      }),
    ])
    expect(first.status(), await first.text()).not.toBe(500)
    expect(second.status(), await second.text()).not.toBe(500)
    expect(await findPage(db, collectionSlug, 'a.html')).toBeDefined()
    expect(await findPage(db, collectionSlug, 'b.html')).toBeDefined()
    expect(await findCollection(db, collectionSlug)).toBeDefined()
  }
})
