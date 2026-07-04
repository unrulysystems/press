import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  COLLECTION_DEFAULT_VISIBILITIES,
  PAGE_VISIBILITIES,
  SlugValidationError,
  decideAcl,
  parseCollectionSlug,
  parseFileSlug,
} from '@press/core'
import { and, eq, isNull, sql } from 'drizzle-orm'

import { verifyApiToken } from '../auth/apiTokens'
import { db, dbConfig } from '../db/client'
import { auditEvent, collection, page } from '../db/schema'
import { hashPagePassword } from './passwords'
import { publishResponseBody } from './responseShape'
import { archiveBlob, installBlob, removeTempBlob, writeTempBlob } from './storage'

import type { PublishResponseBody } from './responseShape'

import type {
  AclOperation,
  AuthenticatedViewer,
  CollectionDefaultVisibility,
  CollectionSlug,
  FileSlug,
  PageVisibility,
} from '@press/core'
import type { InferSelectModel } from 'drizzle-orm'

type CollectionRow = InferSelectModel<typeof collection>
type PageRow = InferSelectModel<typeof page>

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

type PageRoute = {
  readonly collectionSlug: CollectionSlug
  readonly fileSlug: FileSlug
  readonly suffix?: 'password'
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: error.message }, error.status)
  }
  if (error instanceof SlugValidationError) {
    return json({ error: error.message }, 400)
  }
  return json({ error: 'internal server error' }, 500)
}

function viewerFromToken(user: {
  readonly id: string
  readonly email: string
  readonly role: 'user' | 'admin'
}): AuthenticatedViewer {
  return {
    kind: 'authenticated',
    userId: user.id,
    email: user.email,
    role: user.role,
  }
}

function parsePagePath(request: Request): PageRoute {
  const path = new URL(request.url).pathname
  const raw = path.slice('/api/pages/'.length)
  const segments = raw.split('/').map((segment) => decodeURIComponent(segment))
  if (segments.length !== 2 && !(segments.length === 3 && segments[2] === 'password')) {
    throw new HttpError(404, 'page endpoint not found')
  }
  const suffix = segments[2] === 'password' ? 'password' : undefined
  return {
    collectionSlug: parseCollectionSlug(segments[0] ?? ''),
    fileSlug: parseFileSlug(segments[1] ?? ''),
    ...(suffix ? { suffix } : {}),
  }
}

function parseCollectionPath(request: Request): {
  readonly collectionSlug: CollectionSlug
  readonly suffix?: 'pages'
} {
  const path = new URL(request.url).pathname
  const raw = path.slice('/api/collections/'.length)
  const segments = raw.split('/').map((segment) => decodeURIComponent(segment))
  if (segments.length !== 1 && !(segments.length === 2 && segments[1] === 'pages')) {
    throw new HttpError(404, 'collection endpoint not found')
  }
  return {
    collectionSlug: parseCollectionSlug(segments[0] ?? ''),
    ...(segments[1] === 'pages' ? { suffix: 'pages' as const } : {}),
  }
}

function isCollectionsIndexPath(request: Request): boolean {
  const path = new URL(request.url).pathname
  return path === '/api/collections' || path === '/api/collections/'
}

function parseVisibility(value: string | null, field: string): PageVisibility | undefined {
  if (value === null) {
    return undefined
  }
  if ((PAGE_VISIBILITIES as readonly string[]).includes(value)) {
    return value as PageVisibility
  }
  throw new HttpError(400, `${field} must be one of ${PAGE_VISIBILITIES.join(', ')}`)
}

function parseOptionalVisibilityPatch(value: unknown): PageVisibility | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, 'visibility must be a string or null')
  }
  return parseVisibility(value, 'visibility')
}

function parseCollectionDefaultVisibility(
  value: string | null,
  field: string,
): CollectionDefaultVisibility | null {
  if (value === null) {
    return null
  }
  if ((COLLECTION_DEFAULT_VISIBILITIES as readonly string[]).includes(value)) {
    return value as CollectionDefaultVisibility
  }
  throw new HttpError(
    400,
    `${field} must be one of ${COLLECTION_DEFAULT_VISIBILITIES.join(', ')}; password is page-explicit only`,
  )
}

function parseOptionalCollectionDefaultVisibilityPatch(
  value: unknown,
): CollectionDefaultVisibility | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, 'defaultVisibility must be a string or null')
  }
  return parseCollectionDefaultVisibility(value, 'defaultVisibility')
}

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, `${field} must be a string`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new HttpError(400, `${field} must not be empty`)
  }
  return trimmed
}

function parseAllowlist(value: string | null): string[] | undefined {
  if (value === null) {
    return undefined
  }
  return parseAllowlistArray(value.split(','))
}

function parseAllowlistArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'allowlist must be an array of emails')
  }
  const emails = value
    .map((entry) => {
      if (typeof entry !== 'string') {
        throw new HttpError(400, 'allowlist must contain only emails')
      }
      return entry.trim().toLowerCase()
    })
    .filter(Boolean)
  const invalid = emails.find((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  if (invalid) {
    throw new HttpError(400, `invalid allowlist email "${invalid}"`)
  }
  return [...new Set(emails)]
}

function contentHash(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

function generatePagePassword(): string {
  return randomBytes(18).toString('base64url')
}

function extractTitle(html: string, fileSlug: FileSlug, override?: string): string {
  if (override) {
    return override
  }
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const extracted = match?.[1]?.replace(/\s+/g, ' ').trim()
  return extracted || fileSlug
}

async function readHtmlBody(request: Request): Promise<Uint8Array> {
  const type = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (!type.split(';')[0]?.trim().startsWith('text/html')) {
    throw new HttpError(415, 'content-type must be text/html')
  }

  const declaredLength = request.headers.get('content-length')
  if (declaredLength && Number(declaredLength) > dbConfig.maxUploadBytes) {
    await rejectOversizedBody(request)
  }

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = request.body?.getReader()
  if (!reader) {
    return new Uint8Array()
  }

  for (;;) {
    // Read chunks sequentially so the upload cap can fail before buffering the full body.
    // oxlint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > dbConfig.maxUploadBytes) {
      throw new HttpError(413, 'request body exceeds PRESS_MAX_UPLOAD_BYTES')
    }
    chunks.push(value)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

async function rejectOversizedBody(request: Request): Promise<never> {
  // One's Node production server can reset the socket if a handler returns while
  // the client is still uploading. Drain the smallest contract-relevant body
  // prefix, then cancel anything larger without buffering it.
  await disposeOversizedRequestBody(request, dbConfig.maxUploadBytes + 1).catch(() => undefined)
  throw new HttpError(413, 'request body exceeds PRESS_MAX_UPLOAD_BYTES')
}

async function disposeOversizedRequestBody(request: Request, byteLimit: number): Promise<void> {
  const reader = request.body?.getReader()
  if (!reader) {
    return
  }

  let drained = 0
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- The stream must be consumed sequentially.
    const { done, value } = await reader.read()
    if (done) {
      return
    }
    drained += value.byteLength
    if (drained > byteLimit) {
      // oxlint-disable-next-line no-await-in-loop -- Cancel happens only after the bounded drain cap trips.
      await reader.cancel('request body exceeds PRESS_MAX_UPLOAD_BYTES')
      return
    }
  }
}

function pageAcl(
  row: Pick<PageRow, 'collectionSlug' | 'fileSlug' | 'visibility' | 'passwordHash' | 'allowlist'>,
) {
  return {
    collectionSlug: row.collectionSlug,
    fileSlug: row.fileSlug,
    visibility: row.visibility,
    passwordHash: row.passwordHash,
    allowlist: row.allowlist,
  }
}

function collectionAcl(row: Pick<CollectionRow, 'slug' | 'ownerId' | 'defaultVisibility'>) {
  const defaultVisibility = parseCollectionDefaultVisibility(
    row.defaultVisibility,
    'collection.defaultVisibility',
  )
  return {
    slug: row.slug,
    ownerId: row.ownerId,
    defaultVisibility,
  }
}

function assertMutationAllowed(input: {
  readonly user: AuthenticatedViewer
  readonly collection: Pick<CollectionRow, 'slug' | 'ownerId' | 'defaultVisibility'>
  readonly page: Pick<
    PageRow,
    'collectionSlug' | 'fileSlug' | 'visibility' | 'passwordHash' | 'allowlist'
  >
  readonly operation: AclOperation
}): void {
  const decision = decideAcl(input.user, pageAcl(input.page), collectionAcl(input.collection), {
    allowedDomains: dbConfig.allowedDomains,
    operation: input.operation,
  })
  if (!decision.allowed) {
    throw new HttpError(decision.reason === 'authentication-required' ? 401 : 403, decision.reason)
  }
}

function resolvedVisibility(
  pageVisibility: PageVisibility | null | undefined,
  collectionVisibility: CollectionDefaultVisibility | null | undefined,
): PageVisibility {
  return pageVisibility ?? collectionVisibility ?? 'default'
}

function pageResponse(input: {
  readonly collectionSlug: CollectionSlug
  readonly fileSlug: FileSlug
  readonly title: string
  readonly visibility: PageVisibility
  readonly password?: string
  readonly allowlist?: readonly string[]
}): PublishResponseBody {
  return publishResponseBody({ baseUrl: dbConfig.baseUrl, ...input })
}

async function authenticatedViewer(request: Request) {
  const verified = await verifyApiToken(db, request.headers)
  if (!verified) {
    throw new HttpError(401, 'valid bearer token required')
  }
  return {
    token: verified,
    viewer: viewerFromToken(verified.user),
  }
}

export async function pagesEndpoint(request: Request): Promise<Response> {
  try {
    const route = parsePagePath(request)
    if (route.suffix === 'password') {
      if (request.method !== 'POST') {
        return json({ error: 'method not allowed' }, 405)
      }
      return await rerollPassword(request, route)
    }
    switch (request.method) {
      case 'PUT':
        return await publishPage(request, route)
      case 'PATCH':
        return await patchPage(request, route)
      case 'DELETE':
        return await deletePage(request, route)
      default:
        return json({ error: 'method not allowed' }, 405)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

async function publishPage(request: Request, route: PageRoute): Promise<Response> {
  const { viewer } = await authenticatedViewer(request)
  const url = new URL(request.url)
  if (url.searchParams.has('password')) {
    throw new HttpError(400, 'publisher-chosen passwords are unsupported')
  }
  const requestedVisibility = parseVisibility(url.searchParams.get('visibility'), 'visibility')
  const requestedAllowlist = parseAllowlist(url.searchParams.get('allow'))
  const titleOverride = parseOptionalString(url.searchParams.get('title') ?? undefined, 'title')

  const existingCollection = await db.query.collection.findFirst({
    where: eq(collection.slug, route.collectionSlug),
  })
  const existingPage = await db.query.page.findFirst({
    where: and(eq(page.collectionSlug, route.collectionSlug), eq(page.fileSlug, route.fileSlug)),
  })

  assertMutationAllowed({
    user: viewer,
    collection:
      existingCollection ??
      ({
        slug: route.collectionSlug,
        ownerId: viewer.userId,
        defaultVisibility: 'default',
      } satisfies Pick<CollectionRow, 'slug' | 'ownerId' | 'defaultVisibility'>),
    page:
      existingPage ??
      ({
        collectionSlug: route.collectionSlug,
        fileSlug: route.fileSlug,
        visibility: requestedVisibility ?? null,
        passwordHash: null,
        allowlist: requestedAllowlist ?? [],
      } satisfies Pick<
        PageRow,
        'collectionSlug' | 'fileSlug' | 'visibility' | 'passwordHash' | 'allowlist'
      >),
    operation:
      existingPage && !existingPage.archivedAt ? { kind: 'overwrite' } : { kind: 'publish' },
  })

  const body = await readHtmlBody(request)
  const hash = contentHash(body)
  const html = new TextDecoder().decode(body)
  const title = extractTitle(html, route.fileSlug, titleOverride)
  const tempPath = await writeTempBlob(
    dbConfig.storageDir,
    route.collectionSlug,
    route.fileSlug,
    body,
  )
  let rollbackBlob: (() => Promise<void>) | undefined
  let commitBlob: (() => Promise<void>) | undefined
  let tempInstalled = false

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${route.collectionSlug}), hashtext(${route.fileSlug}))`,
      )
      const txCollection =
        (await tx.query.collection.findFirst({
          where: eq(collection.slug, route.collectionSlug),
        })) ??
        (
          await tx
            .insert(collection)
            .values({
              slug: route.collectionSlug,
              ownerId: viewer.userId,
            })
            .returning()
        )[0]

      if (!txCollection) {
        throw new HttpError(500, 'collection write failed')
      }

      const txPage = await tx.query.page.findFirst({
        where: and(
          eq(page.collectionSlug, route.collectionSlug),
          eq(page.fileSlug, route.fileSlug),
        ),
      })
      const action = txPage && !txPage.archivedAt ? 'overwrite' : 'publish'
      assertMutationAllowed({
        user: viewer,
        collection: txCollection,
        page:
          txPage ??
          ({
            collectionSlug: route.collectionSlug,
            fileSlug: route.fileSlug,
            visibility: requestedVisibility ?? null,
            passwordHash: null,
            allowlist: requestedAllowlist ?? [],
          } satisfies Pick<
            PageRow,
            'collectionSlug' | 'fileSlug' | 'visibility' | 'passwordHash' | 'allowlist'
          >),
        operation: { kind: action },
      })

      const visibility = requestedVisibility ?? txPage?.visibility ?? null
      const allowlist = requestedAllowlist ?? txPage?.allowlist ?? []
      const generatedPassword =
        requestedVisibility === 'password' ? generatePagePassword() : undefined
      const passwordHash = generatedPassword
        ? await hashPagePassword(generatedPassword)
        : visibility === 'password'
          ? (txPage?.passwordHash ?? null)
          : null

      const blob = await installBlob(
        dbConfig.storageDir,
        route.collectionSlug,
        route.fileSlug,
        tempPath,
      )
      tempInstalled = true
      rollbackBlob = blob.rollback
      commitBlob = blob.commit

      const pageValues = {
        id: txPage?.id ?? randomUUID(),
        collectionSlug: route.collectionSlug,
        fileSlug: route.fileSlug,
        title,
        visibility,
        passwordHash,
        allowlist,
        contentHash: hash,
        sizeBytes: body.byteLength,
        publishedBy: viewer.userId,
        updatedAt: new Date(),
        archivedAt: null,
      }

      await tx
        .insert(page)
        .values(pageValues)
        .onConflictDoUpdate({
          target: [page.collectionSlug, page.fileSlug],
          set: {
            title: pageValues.title,
            visibility: pageValues.visibility,
            passwordHash: pageValues.passwordHash,
            allowlist: pageValues.allowlist,
            contentHash: pageValues.contentHash,
            sizeBytes: pageValues.sizeBytes,
            publishedBy: pageValues.publishedBy,
            updatedAt: pageValues.updatedAt,
            archivedAt: null,
          },
        })

      await tx.insert(auditEvent).values({
        id: randomUUID(),
        userId: viewer.userId,
        action,
        collectionSlug: route.collectionSlug,
        fileSlug: route.fileSlug,
        contentHash: hash,
      })

      return pageResponse({
        collectionSlug: route.collectionSlug,
        fileSlug: route.fileSlug,
        title,
        visibility: resolvedVisibility(visibility, collectionAcl(txCollection).defaultVisibility),
        allowlist,
        ...(generatedPassword ? { password: generatedPassword } : {}),
      })
    })
    const cleanupBlob = commitBlob
    rollbackBlob = undefined
    commitBlob = undefined
    if (cleanupBlob) {
      await cleanupBlob()
    }
    return json(result)
  } catch (error) {
    if (rollbackBlob) {
      await rollbackBlob()
    }
    if (!tempInstalled) {
      await removeTempBlob(tempPath)
    }
    throw error
  }
}

async function patchPage(request: Request, route: PageRoute): Promise<Response> {
  const { viewer } = await authenticatedViewer(request)
  const body = await request.json().catch(() => {
    throw new HttpError(400, 'request body must be JSON')
  })
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'request body must be a JSON object')
  }

  const input = body as Record<string, unknown>
  const visibility = parseOptionalVisibilityPatch(input.visibility)
  const allowlist = input.allowlist === undefined ? undefined : parseAllowlistArray(input.allowlist)
  const title = parseOptionalString(input.title, 'title')
  if (visibility === undefined && allowlist === undefined && title === undefined) {
    throw new HttpError(400, 'at least one patch field is required')
  }

  const existingCollection = await db.query.collection.findFirst({
    where: eq(collection.slug, route.collectionSlug),
  })
  const existingPage = await db.query.page.findFirst({
    where: and(
      eq(page.collectionSlug, route.collectionSlug),
      eq(page.fileSlug, route.fileSlug),
      isNull(page.archivedAt),
    ),
  })
  if (!existingCollection || !existingPage) {
    throw new HttpError(404, 'page not found')
  }
  assertMutationAllowed({
    user: viewer,
    collection: existingCollection,
    page: existingPage,
    operation: { kind: 'change-visibility' },
  })

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${route.collectionSlug}), hashtext(${route.fileSlug}))`,
    )
    const password =
      visibility === 'password' && !existingPage.passwordHash ? generatePagePassword() : undefined
    const passwordHash = password
      ? await hashPagePassword(password)
      : visibility && visibility !== 'password'
        ? null
        : existingPage.passwordHash

    await tx
      .update(page)
      .set({
        ...(visibility !== undefined ? { visibility } : {}),
        ...(allowlist !== undefined ? { allowlist } : {}),
        ...(title !== undefined ? { title } : {}),
        passwordHash,
        updatedAt: new Date(),
      })
      .where(and(eq(page.collectionSlug, route.collectionSlug), eq(page.fileSlug, route.fileSlug)))

    await tx.insert(auditEvent).values({
      id: randomUUID(),
      userId: viewer.userId,
      action: 'visibility-change',
      collectionSlug: route.collectionSlug,
      fileSlug: route.fileSlug,
      contentHash: existingPage.contentHash,
    })

    return pageResponse({
      collectionSlug: route.collectionSlug,
      fileSlug: route.fileSlug,
      title: title ?? existingPage.title,
      visibility: resolvedVisibility(
        visibility === undefined ? existingPage.visibility : visibility,
        collectionAcl(existingCollection).defaultVisibility,
      ),
      allowlist: allowlist ?? existingPage.allowlist,
      ...(password ? { password } : {}),
    })
  })
  return json(result)
}

async function rerollPassword(request: Request, route: PageRoute): Promise<Response> {
  const { viewer } = await authenticatedViewer(request)
  const existingCollection = await db.query.collection.findFirst({
    where: eq(collection.slug, route.collectionSlug),
  })
  const existingPage = await db.query.page.findFirst({
    where: and(
      eq(page.collectionSlug, route.collectionSlug),
      eq(page.fileSlug, route.fileSlug),
      isNull(page.archivedAt),
    ),
  })
  if (!existingCollection || !existingPage) {
    throw new HttpError(404, 'page not found')
  }
  assertMutationAllowed({
    user: viewer,
    collection: existingCollection,
    page: existingPage,
    operation: { kind: 'change-password' },
  })

  const password = generatePagePassword()
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${route.collectionSlug}), hashtext(${route.fileSlug}))`,
    )
    await tx
      .update(page)
      .set({
        visibility: 'password',
        passwordHash: await hashPagePassword(password),
        updatedAt: new Date(),
      })
      .where(and(eq(page.collectionSlug, route.collectionSlug), eq(page.fileSlug, route.fileSlug)))
    await tx.insert(auditEvent).values({
      id: randomUUID(),
      userId: viewer.userId,
      action: 'password-reroll',
      collectionSlug: route.collectionSlug,
      fileSlug: route.fileSlug,
      contentHash: existingPage.contentHash,
    })
  })

  return json(
    pageResponse({
      collectionSlug: route.collectionSlug,
      fileSlug: route.fileSlug,
      title: existingPage.title,
      visibility: 'password',
      password,
    }),
  )
}

async function deletePage(request: Request, route: PageRoute): Promise<Response> {
  const { viewer } = await authenticatedViewer(request)
  const existingCollection = await db.query.collection.findFirst({
    where: eq(collection.slug, route.collectionSlug),
  })
  const existingPage = await db.query.page.findFirst({
    where: and(
      eq(page.collectionSlug, route.collectionSlug),
      eq(page.fileSlug, route.fileSlug),
      isNull(page.archivedAt),
    ),
  })
  if (!existingCollection || !existingPage) {
    throw new HttpError(404, 'page not found')
  }
  assertMutationAllowed({
    user: viewer,
    collection: existingCollection,
    page: existingPage,
    operation: { kind: 'unpublish' },
  })

  let rollbackBlob: (() => Promise<void>) | undefined
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${route.collectionSlug}), hashtext(${route.fileSlug}))`,
      )
      const blob = await archiveBlob(dbConfig.storageDir, route.collectionSlug, route.fileSlug)
      rollbackBlob = blob.rollback
      await tx
        .update(page)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(
          and(eq(page.collectionSlug, route.collectionSlug), eq(page.fileSlug, route.fileSlug)),
        )
      await tx.insert(auditEvent).values({
        id: randomUUID(),
        userId: viewer.userId,
        action: 'unpublish',
        collectionSlug: route.collectionSlug,
        fileSlug: route.fileSlug,
        contentHash: existingPage.contentHash,
      })
    })
    rollbackBlob = undefined
    return json({ ok: true })
  } catch (error) {
    if (rollbackBlob) {
      await rollbackBlob()
    }
    throw error
  }
}

export async function collectionsIndexEndpoint(request: Request): Promise<Response> {
  try {
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405)
    }
    const { viewer } = await authenticatedViewer(request)
    const rows = await db
      .select({
        collection,
        page,
      })
      .from(page)
      .innerJoin(collection, eq(page.collectionSlug, collection.slug))
      .where(isNull(page.archivedAt))

    const collections = new Map<string, CollectionRow>()
    for (const row of rows) {
      const decision = decideAcl(viewer, pageAcl(row.page), collectionAcl(row.collection), {
        allowedDomains: dbConfig.allowedDomains,
      })
      if (decision.allowed) {
        collections.set(row.collection.slug, row.collection)
      }
    }

    return json({
      collections: [...collections.values()].map((row) => ({
        slug: row.slug,
        title: row.title,
        defaultVisibility: collectionAcl(row).defaultVisibility,
      })),
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function collectionsEndpoint(request: Request): Promise<Response> {
  try {
    if (request.method === 'GET' && isCollectionsIndexPath(request)) {
      return await collectionsIndexEndpoint(request)
    }
    const route = parseCollectionPath(request)
    if (request.method === 'GET' && route.suffix === 'pages') {
      return await listCollectionPages(request, route.collectionSlug)
    }
    if (request.method === 'PATCH' && !route.suffix) {
      return await patchCollection(request, route.collectionSlug)
    }
    return json({ error: 'method not allowed' }, 405)
  } catch (error) {
    return errorResponse(error)
  }
}

async function listCollectionPages(
  request: Request,
  collectionSlug: CollectionSlug,
): Promise<Response> {
  const { viewer } = await authenticatedViewer(request)
  const existingCollection = await db.query.collection.findFirst({
    where: eq(collection.slug, collectionSlug),
  })
  if (!existingCollection) {
    throw new HttpError(404, 'collection not found')
  }
  const existingCollectionDefault = collectionAcl(existingCollection).defaultVisibility

  const rows = await db.query.page.findMany({
    where: and(eq(page.collectionSlug, collectionSlug), isNull(page.archivedAt)),
    orderBy: (fields, { desc }) => [desc(fields.publishedAt)],
  })

  return json({
    pages: rows
      .filter(
        (row) =>
          decideAcl(viewer, pageAcl(row), collectionAcl(existingCollection), {
            allowedDomains: dbConfig.allowedDomains,
          }).allowed,
      )
      .map((row) => ({
        collection: row.collectionSlug,
        file: row.fileSlug,
        title: row.title,
        visibility: resolvedVisibility(row.visibility, existingCollectionDefault),
        contentHash: row.contentHash,
        updatedAt: row.updatedAt.toISOString(),
      })),
  })
}

async function patchCollection(
  request: Request,
  collectionSlug: CollectionSlug,
): Promise<Response> {
  const { viewer } = await authenticatedViewer(request)
  const body = await request.json().catch(() => {
    throw new HttpError(400, 'request body must be JSON')
  })
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'request body must be a JSON object')
  }
  const input = body as Record<string, unknown>
  const defaultVisibility = parseOptionalCollectionDefaultVisibilityPatch(input.defaultVisibility)
  if (defaultVisibility === null) {
    throw new HttpError(400, 'defaultVisibility cannot be null')
  }
  const title = input.title === null ? null : parseOptionalString(input.title, 'title')
  if (defaultVisibility === undefined && title === undefined) {
    throw new HttpError(400, 'at least one patch field is required')
  }

  const existingCollection = await db.query.collection.findFirst({
    where: eq(collection.slug, collectionSlug),
  })
  if (!existingCollection) {
    throw new HttpError(404, 'collection not found')
  }
  const existingCollectionDefault = collectionAcl(existingCollection).defaultVisibility
  assertMutationAllowed({
    user: viewer,
    collection: existingCollection,
    page: {
      collectionSlug,
      fileSlug: 'index.html',
      visibility: defaultVisibility ?? existingCollectionDefault,
      passwordHash: null,
      allowlist: [],
    },
    operation: { kind: 'change-visibility' },
  })

  await db.transaction(async (tx) => {
    await tx
      .update(collection)
      .set({
        ...(defaultVisibility !== undefined ? { defaultVisibility } : {}),
        ...(title !== undefined ? { title } : {}),
      })
      .where(eq(collection.slug, collectionSlug))
    await tx.insert(auditEvent).values({
      id: randomUUID(),
      userId: viewer.userId,
      action: 'visibility-change',
      collectionSlug,
    })
  })

  return json({
    collection: {
      slug: collectionSlug,
      title: title === undefined ? existingCollection.title : title,
      defaultVisibility: defaultVisibility ?? existingCollectionDefault,
    },
  })
}
