import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  COLLECTION_DEFAULT_VISIBILITIES,
  PAGE_REDIRECT_MODES,
  PAGE_VISIBILITIES,
  decideAcl,
  parseCollectionSlug,
  parseFileSlug,
} from '@press/core'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'

import { verifyApiToken } from '../auth/apiTokens'
import { getDb, getDbConfig, getPool } from '../db/client'
import { auditEvent, collection, page, pageRedirect, schema } from '../db/schema'
import {
  HttpError,
  jsonErrorResponse,
  jsonResponse,
  logServerWarning,
  readBoundedJsonObject,
} from '../http/responses'
import { MIN_PAGE_PASSWORD_LENGTH, hashPagePassword, isStrongPagePassword } from './passwords'
import { withPagePathLocks } from './pagePathLocks'
import { moveResponseBody, publishResponseBody } from './responseShape'
import { MAX_TITLE_LENGTH, extractTitle } from './title'
import { archiveBlob, installBlob, moveBlob, removeTempBlob, writeTempBlob } from './storage'

import type { MoveResponseBody, PublishResponseBody } from './responseShape'

import type {
  AclOperation,
  AuthenticatedViewer,
  CollectionDefaultVisibility,
  CollectionSlug,
  FileSlug,
  PageRedirectMode,
  PageVisibility,
} from '@press/core'
import type { InferSelectModel } from 'drizzle-orm'

type CollectionRow = InferSelectModel<typeof collection>
type PageRow = InferSelectModel<typeof page>

const MAX_ALLOWLIST_ENTRIES = 500
const MAX_LIST_ROWS = 1000

type PageRoute = {
  readonly collectionSlug: CollectionSlug
  readonly fileSlug: FileSlug
  readonly suffix?: 'move' | 'password'
}

export async function readMutationJson(
  request: Request,
  byteLimit: number = getDbConfig().maxMetadataBytes,
): Promise<Record<string, unknown>> {
  return await readBoundedJsonObject(request, byteLimit)
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

function decodePathSegments(raw: string): string[] {
  try {
    return raw.split('/').map((segment) => decodeURIComponent(segment))
  } catch (error) {
    throw new HttpError(400, 'malformed percent-encoding in path', { cause: error })
  }
}

function parsePagePath(request: Request): PageRoute {
  const path = new URL(request.url).pathname
  const raw = path.slice('/api/pages/'.length)
  const segments = decodePathSegments(raw)
  const suffix = segments[2]
  if (
    segments.length !== 2 &&
    !(segments.length === 3 && (suffix === 'move' || suffix === 'password'))
  ) {
    throw new HttpError(404, 'page endpoint not found')
  }
  return {
    collectionSlug: parseCollectionSlug(segments[0] ?? ''),
    fileSlug: parseFileSlug(segments[1] ?? ''),
    ...(suffix === 'move' || suffix === 'password' ? { suffix } : {}),
  }
}

function parseCollectionPath(request: Request): {
  readonly collectionSlug: CollectionSlug
  readonly suffix?: 'pages'
} {
  const path = new URL(request.url).pathname
  const raw = path.slice('/api/collections/'.length)
  const segments = decodePathSegments(raw)
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
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new HttpError(400, `${field} must be at most ${MAX_TITLE_LENGTH} characters`)
  }
  return trimmed
}

function parseMoveRedirectMode(value: unknown): PageRedirectMode {
  const mode = value === undefined ? 'permanent' : value
  if (typeof mode === 'string' && (PAGE_REDIRECT_MODES as readonly string[]).includes(mode)) {
    return mode as PageRedirectMode
  }
  throw new HttpError(400, `redirect must be one of ${PAGE_REDIRECT_MODES.join(', ')}`)
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
  if (value.length > MAX_ALLOWLIST_ENTRIES) {
    throw new HttpError(400, `allowlist cannot exceed ${MAX_ALLOWLIST_ENTRIES} entries`)
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

// A publisher-supplied custom password (REQ-PUB-005) arrives in a request header,
// never a query param (INV-4).
function readCustomPagePassword(request: Request): string | undefined {
  const raw = request.headers.get('x-press-page-password')
  return raw === null ? undefined : raw
}

async function readHtmlBody(request: Request): Promise<Uint8Array> {
  const maxUploadBytes = getDbConfig().maxUploadBytes
  const type = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (!type.split(';')[0]?.trim().startsWith('text/html')) {
    throw new HttpError(415, 'content-type must be text/html')
  }

  const declaredLength = request.headers.get('content-length')
  if (declaredLength && Number(declaredLength) > maxUploadBytes) {
    await rejectOversizedBody(request, maxUploadBytes)
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
    if (total > maxUploadBytes) {
      // oxlint-disable-next-line no-await-in-loop -- Cancel happens once at the bounded rejection point.
      await reader.cancel('request body exceeds PRESS_MAX_UPLOAD_BYTES').catch(() => undefined)
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

async function rejectOversizedBody(request: Request, maxUploadBytes: number): Promise<never> {
  // One's Node production server can reset the socket if a handler returns while
  // the client is still uploading. Drain the smallest contract-relevant body
  // prefix, then cancel anything larger without buffering it.
  await disposeOversizedRequestBody(request, maxUploadBytes + 1).catch(() => undefined)
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
    allowedDomains: getDbConfig().allowedDomains,
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
  return publishResponseBody({ baseUrl: getDbConfig().baseUrl, ...input })
}

async function authenticatedViewer(request: Request) {
  const verified = await verifyApiToken(getDb(), request.headers, getDbConfig().adminEmails)
  if (!verified) {
    throw new HttpError(401, 'valid bearer token required')
  }
  return {
    token: verified,
    viewer: viewerFromToken(verified.user),
  }
}

async function rollbackBlobPreservingError(
  error: unknown,
  rollbackBlob: (() => Promise<void>) | undefined,
  operation: string,
): Promise<never> {
  if (rollbackBlob) {
    let rollbackError: unknown
    try {
      await rollbackBlob()
    } catch (caught) {
      rollbackError = caught
    }
    if (rollbackError !== undefined) {
      throw new AggregateError([error, rollbackError], `${operation} rollback failed`)
    }
  }
  throw error
}

export async function pagesEndpoint(request: Request): Promise<Response> {
  try {
    const route = parsePagePath(request)
    if (route.suffix === 'password') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'method not allowed' }, 405)
      }
      return await rerollPassword(request, route)
    }
    if (route.suffix === 'move') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'method not allowed' }, 405)
      }
      return await movePage(request, route)
    }
    switch (request.method) {
      case 'PUT':
        return await publishPage(request, route)
      case 'PATCH':
        return await patchPage(request, route)
      case 'DELETE':
        return await deletePage(request, route)
      default:
        return jsonResponse({ error: 'method not allowed' }, 405)
    }
  } catch (error) {
    return jsonErrorResponse('pagesEndpoint', error, request)
  }
}

async function publishPage(request: Request, route: PageRoute): Promise<Response> {
  const { viewer } = await authenticatedViewer(request)
  const url = new URL(request.url)
  if (url.searchParams.has('password')) {
    throw new HttpError(
      400,
      'supply a custom page password via the X-Press-Page-Password header, not a query param (it would be logged)',
    )
  }
  const requestedVisibility = parseVisibility(url.searchParams.get('visibility'), 'visibility')
  const requestedAllowlist = parseAllowlist(url.searchParams.get('allow'))
  const titleOverride = parseOptionalString(url.searchParams.get('title') ?? undefined, 'title')
  const customPassword = readCustomPagePassword(request)
  if (customPassword !== undefined) {
    if (requestedVisibility !== 'password') {
      throw new HttpError(400, 'a custom page password requires visibility=password')
    }
    if (!isStrongPagePassword(customPassword)) {
      throw new HttpError(
        400,
        `page password must be at least ${MIN_PAGE_PASSWORD_LENGTH} characters`,
      )
    }
  }

  const db = getDb()
  const config = getDbConfig()
  const existingCollection = await db.query.collection.findFirst({
    where: eq(collection.slug, route.collectionSlug),
  })
  const existingPage = await db.query.page.findFirst({
    where: and(eq(page.collectionSlug, route.collectionSlug), eq(page.fileSlug, route.fileSlug)),
  })
  const existingRedirect = await db.query.pageRedirect.findFirst({
    where: and(
      eq(pageRedirect.sourceCollectionSlug, route.collectionSlug),
      eq(pageRedirect.sourceFileSlug, route.fileSlug),
    ),
  })
  if (existingRedirect) {
    throw new HttpError(409, 'page path is reserved by a redirect')
  }

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
    config.storageDir,
    route.collectionSlug,
    route.fileSlug,
    body,
  )
  let rollbackBlob: (() => Promise<void>) | undefined
  let commitBlob: (() => Promise<void>) | undefined
  let tempInstalled = false

  try {
    return await withPagePathLocks(
      () => getPool().connect(),
      [route],
      async (connection) => {
        const lockedDb = drizzle(connection, { schema })
        try {
          const result = await lockedDb.transaction(async (tx) => {
            let txCollection = await tx.query.collection.findFirst({
              where: eq(collection.slug, route.collectionSlug),
            })
            if (!txCollection) {
              // Concurrent first publishes to a new collection must not collide on insert.
              await tx
                .insert(collection)
                .values({ slug: route.collectionSlug, ownerId: viewer.userId })
                .onConflictDoNothing({ target: collection.slug })
              txCollection = await tx.query.collection.findFirst({
                where: eq(collection.slug, route.collectionSlug),
              })
            }
            if (!txCollection) {
              throw new HttpError(500, 'collection write failed')
            }

            const txPage = await tx.query.page.findFirst({
              where: and(
                eq(page.collectionSlug, route.collectionSlug),
                eq(page.fileSlug, route.fileSlug),
              ),
            })
            const txRedirect = await tx.query.pageRedirect.findFirst({
              where: and(
                eq(pageRedirect.sourceCollectionSlug, route.collectionSlug),
                eq(pageRedirect.sourceFileSlug, route.fileSlug),
              ),
            })
            if (txRedirect) {
              throw new HttpError(409, 'page path is reserved by a redirect')
            }
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

            // Live overwrite preserves current settings; fresh publish or republish
            // over an archived path starts neutral so stale ACL never resurrects.
            const keepsCurrentSettings = action === 'overwrite'
            const visibility =
              requestedVisibility ?? (keepsCurrentSettings ? (txPage?.visibility ?? null) : null)
            const allowlist =
              requestedAllowlist ?? (keepsCurrentSettings ? (txPage?.allowlist ?? []) : [])
            const effectivePassword =
              requestedVisibility === 'password'
                ? (customPassword ?? generatePagePassword())
                : undefined
            const passwordHash = effectivePassword
              ? await hashPagePassword(effectivePassword)
              : visibility === 'password' && keepsCurrentSettings
                ? (txPage?.passwordHash ?? null)
                : null

            const blob = await installBlob(
              config.storageDir,
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
              visibility: resolvedVisibility(
                visibility,
                collectionAcl(txCollection).defaultVisibility,
              ),
              allowlist,
              ...(effectivePassword ? { password: effectivePassword } : {}),
            })
          })
          const cleanupBlob = commitBlob
          rollbackBlob = undefined
          commitBlob = undefined
          if (cleanupBlob) {
            try {
              await cleanupBlob()
            } catch (cleanupError) {
              logServerWarning(
                'publishPage.cleanupBlob',
                { collection: route.collectionSlug, file: route.fileSlug },
                cleanupError,
              )
            }
          }
          return jsonResponse(result)
        } catch (error) {
          return await rollbackBlobPreservingError(error, rollbackBlob, 'publishPage')
        }
      },
    )
  } catch (error) {
    if (!tempInstalled) {
      await removeTempBlob(tempPath)
    }
    throw error
  }
}

type MoveDestination = {
  readonly collectionSlug: CollectionSlug
  readonly fileSlug: FileSlug
  readonly redirect: PageRedirectMode
}

async function readMoveDestination(request: Request): Promise<MoveDestination> {
  const input = await readMutationJson(request)
  if (typeof input.collection !== 'string' || typeof input.file !== 'string') {
    throw new HttpError(400, 'collection and file must be strings')
  }
  return {
    collectionSlug: parseCollectionSlug(input.collection),
    fileSlug: parseFileSlug(input.file),
    redirect: parseMoveRedirectMode(input.redirect),
  }
}

function samePagePath(source: PageRoute, destination: MoveDestination): boolean {
  return (
    source.collectionSlug === destination.collectionSlug && source.fileSlug === destination.fileSlug
  )
}

function mutationPageAt(
  row: Pick<PageRow, 'visibility' | 'passwordHash' | 'allowlist'>,
  collectionSlug: CollectionSlug,
  fileSlug: FileSlug,
): Pick<PageRow, 'collectionSlug' | 'fileSlug' | 'visibility' | 'passwordHash' | 'allowlist'> {
  return {
    collectionSlug,
    fileSlug,
    visibility: row.visibility,
    passwordHash: row.passwordHash,
    allowlist: row.allowlist,
  }
}

async function movePage(request: Request, route: PageRoute): Promise<Response> {
  const { viewer } = await authenticatedViewer(request)
  const destination = await readMoveDestination(request)
  if (samePagePath(route, destination)) {
    throw new HttpError(400, 'destination must differ from source')
  }

  const db = getDb()
  const config = getDbConfig()
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
    operation: { kind: 'move' },
  })

  const existingDestinationCollection = await db.query.collection.findFirst({
    where: eq(collection.slug, destination.collectionSlug),
  })
  assertMutationAllowed({
    user: viewer,
    collection:
      existingDestinationCollection ??
      ({
        slug: destination.collectionSlug,
        ownerId: viewer.userId,
        defaultVisibility: 'default',
      } satisfies Pick<CollectionRow, 'slug' | 'ownerId' | 'defaultVisibility'>),
    page: mutationPageAt(existingPage, destination.collectionSlug, destination.fileSlug),
    operation: { kind: 'move' },
  })

  let rollbackBlob: (() => Promise<void>) | undefined
  return await withPagePathLocks(
    () => getPool().connect(),
    [
      { collectionSlug: route.collectionSlug, fileSlug: route.fileSlug },
      {
        collectionSlug: destination.collectionSlug,
        fileSlug: destination.fileSlug,
      },
    ],
    async (connection) => {
      const lockedDb = drizzle(connection, { schema })
      try {
        const result = await lockedDb.transaction(async (tx): Promise<MoveResponseBody> => {
          const txSourceCollection = await tx.query.collection.findFirst({
            where: eq(collection.slug, route.collectionSlug),
          })
          const txSourcePage = await tx.query.page.findFirst({
            where: and(
              eq(page.collectionSlug, route.collectionSlug),
              eq(page.fileSlug, route.fileSlug),
              isNull(page.archivedAt),
            ),
          })
          if (!txSourceCollection || !txSourcePage) {
            throw new HttpError(404, 'page not found')
          }
          assertMutationAllowed({
            user: viewer,
            collection: txSourceCollection,
            page: txSourcePage,
            operation: { kind: 'move' },
          })

          let txDestinationCollection = await tx.query.collection.findFirst({
            where: eq(collection.slug, destination.collectionSlug),
          })
          if (!txDestinationCollection) {
            await tx
              .insert(collection)
              .values({ slug: destination.collectionSlug, ownerId: viewer.userId })
              .onConflictDoNothing({ target: collection.slug })
            txDestinationCollection = await tx.query.collection.findFirst({
              where: eq(collection.slug, destination.collectionSlug),
            })
          }
          if (!txDestinationCollection) {
            throw new HttpError(500, 'destination collection write failed')
          }
          assertMutationAllowed({
            user: viewer,
            collection: txDestinationCollection,
            page: mutationPageAt(txSourcePage, destination.collectionSlug, destination.fileSlug),
            operation: { kind: 'move' },
          })

          const destinationPage = await tx.query.page.findFirst({
            where: and(
              eq(page.collectionSlug, destination.collectionSlug),
              eq(page.fileSlug, destination.fileSlug),
            ),
          })
          if (destinationPage && !destinationPage.archivedAt) {
            throw new HttpError(409, 'destination page already exists')
          }

          const sourceRedirect = await tx.query.pageRedirect.findFirst({
            where: and(
              eq(pageRedirect.sourceCollectionSlug, route.collectionSlug),
              eq(pageRedirect.sourceFileSlug, route.fileSlug),
            ),
          })
          if (sourceRedirect && sourceRedirect.targetPageId !== txSourcePage.id) {
            throw new HttpError(409, 'source path conflicts with another page redirect')
          }
          const destinationRedirect = await tx.query.pageRedirect.findFirst({
            where: and(
              eq(pageRedirect.sourceCollectionSlug, destination.collectionSlug),
              eq(pageRedirect.sourceFileSlug, destination.fileSlug),
            ),
          })
          if (destinationRedirect && destinationRedirect.targetPageId !== txSourcePage.id) {
            throw new HttpError(409, 'destination path is reserved by another page redirect')
          }

          const blob = await moveBlob(
            config.storageDir,
            route.collectionSlug,
            route.fileSlug,
            destination.collectionSlug,
            destination.fileSlug,
          )
          rollbackBlob = blob.rollback

          if (sourceRedirect) {
            await tx
              .delete(pageRedirect)
              .where(
                and(
                  eq(pageRedirect.sourceCollectionSlug, route.collectionSlug),
                  eq(pageRedirect.sourceFileSlug, route.fileSlug),
                ),
              )
          }
          if (destinationRedirect) {
            await tx
              .delete(pageRedirect)
              .where(
                and(
                  eq(pageRedirect.sourceCollectionSlug, destination.collectionSlug),
                  eq(pageRedirect.sourceFileSlug, destination.fileSlug),
                ),
              )
          }
          if (destinationPage) {
            await tx.delete(page).where(eq(page.id, destinationPage.id))
          }

          const effectiveVisibility = resolvedVisibility(
            txSourcePage.visibility,
            collectionAcl(txSourceCollection).defaultVisibility,
          )
          const storedVisibility =
            route.collectionSlug === destination.collectionSlug
              ? txSourcePage.visibility
              : effectiveVisibility
          await tx
            .update(page)
            .set({
              collectionSlug: destination.collectionSlug,
              fileSlug: destination.fileSlug,
              visibility: storedVisibility,
              updatedAt: new Date(),
            })
            .where(eq(page.id, txSourcePage.id))

          if (destination.redirect === 'permanent') {
            await tx.insert(pageRedirect).values({
              sourceCollectionSlug: route.collectionSlug,
              sourceFileSlug: route.fileSlug,
              targetPageId: txSourcePage.id,
              kind: 'permanent',
              createdBy: viewer.userId,
            })
          }

          await tx.insert(auditEvent).values({
            id: randomUUID(),
            userId: viewer.userId,
            action: 'move',
            collectionSlug: route.collectionSlug,
            fileSlug: route.fileSlug,
            contentHash: txSourcePage.contentHash,
            details: {
              kind: 'move',
              source: { collection: route.collectionSlug, file: route.fileSlug },
              destination: {
                collection: destination.collectionSlug,
                file: destination.fileSlug,
              },
              redirect: destination.redirect,
            },
          })

          return moveResponseBody({
            baseUrl: config.baseUrl,
            sourceCollectionSlug: route.collectionSlug,
            sourceFileSlug: route.fileSlug,
            destinationCollectionSlug: destination.collectionSlug,
            destinationFileSlug: destination.fileSlug,
            redirect: destination.redirect,
            title: txSourcePage.title,
            visibility: effectiveVisibility,
          })
        })
        rollbackBlob = undefined
        return jsonResponse(result)
      } catch (error) {
        return await rollbackBlobPreservingError(error, rollbackBlob, 'movePage')
      }
    },
  )
}

async function patchPage(request: Request, route: PageRoute): Promise<Response> {
  const { viewer } = await authenticatedViewer(request)
  const input = await readMutationJson(request)
  const visibility = parseOptionalVisibilityPatch(input.visibility)
  const allowlist = input.allowlist === undefined ? undefined : parseAllowlistArray(input.allowlist)
  const title = parseOptionalString(input.title, 'title')
  const customPassword = readCustomPagePassword(request)
  if (customPassword !== undefined) {
    if (visibility !== undefined && visibility !== 'password') {
      throw new HttpError(400, 'a custom page password requires visibility=password')
    }
    if (!isStrongPagePassword(customPassword)) {
      throw new HttpError(
        400,
        `page password must be at least ${MIN_PAGE_PASSWORD_LENGTH} characters`,
      )
    }
  }
  if (
    visibility === undefined &&
    allowlist === undefined &&
    title === undefined &&
    customPassword === undefined
  ) {
    throw new HttpError(400, 'at least one patch field is required')
  }

  const result = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${route.collectionSlug}), hashtext(${route.fileSlug}))`,
    )

    const txCollection = await tx.query.collection.findFirst({
      where: eq(collection.slug, route.collectionSlug),
    })
    const txPage = await tx.query.page.findFirst({
      where: and(
        eq(page.collectionSlug, route.collectionSlug),
        eq(page.fileSlug, route.fileSlug),
        isNull(page.archivedAt),
      ),
    })
    if (!txCollection || !txPage) {
      throw new HttpError(404, 'page not found')
    }
    assertMutationAllowed({
      user: viewer,
      collection: txCollection,
      page: txPage,
      operation: { kind: 'change-visibility' },
    })

    const effectiveVisibilityPatch = customPassword !== undefined ? 'password' : visibility
    const password =
      customPassword !== undefined
        ? customPassword
        : effectiveVisibilityPatch === 'password' && !txPage.passwordHash
          ? generatePagePassword()
          : undefined
    const passwordHash = password
      ? await hashPagePassword(password)
      : effectiveVisibilityPatch !== undefined && effectiveVisibilityPatch !== 'password'
        ? null
        : txPage.passwordHash

    await tx
      .update(page)
      .set({
        ...(effectiveVisibilityPatch !== undefined ? { visibility: effectiveVisibilityPatch } : {}),
        ...(allowlist !== undefined ? { allowlist } : {}),
        ...(title !== undefined ? { title } : {}),
        passwordHash,
        updatedAt: new Date(),
      })
      .where(eq(page.id, txPage.id))

    await tx.insert(auditEvent).values({
      id: randomUUID(),
      userId: viewer.userId,
      action: 'visibility-change',
      collectionSlug: route.collectionSlug,
      fileSlug: route.fileSlug,
      contentHash: txPage.contentHash,
    })

    return pageResponse({
      collectionSlug: route.collectionSlug,
      fileSlug: route.fileSlug,
      title: title ?? txPage.title,
      visibility: resolvedVisibility(
        effectiveVisibilityPatch === undefined ? txPage.visibility : effectiveVisibilityPatch,
        collectionAcl(txCollection).defaultVisibility,
      ),
      allowlist: allowlist ?? txPage.allowlist,
      ...(password ? { password } : {}),
    })
  })
  return jsonResponse(result)
}

async function rerollPassword(request: Request, route: PageRoute): Promise<Response> {
  const { viewer } = await authenticatedViewer(request)
  const customPassword = readCustomPagePassword(request)
  if (customPassword !== undefined && !isStrongPagePassword(customPassword)) {
    throw new HttpError(
      400,
      `page password must be at least ${MIN_PAGE_PASSWORD_LENGTH} characters`,
    )
  }
  const result = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${route.collectionSlug}), hashtext(${route.fileSlug}))`,
    )

    const txCollection = await tx.query.collection.findFirst({
      where: eq(collection.slug, route.collectionSlug),
    })
    const txPage = await tx.query.page.findFirst({
      where: and(
        eq(page.collectionSlug, route.collectionSlug),
        eq(page.fileSlug, route.fileSlug),
        isNull(page.archivedAt),
      ),
    })
    if (!txCollection || !txPage) {
      throw new HttpError(404, 'page not found')
    }
    assertMutationAllowed({
      user: viewer,
      collection: txCollection,
      page: txPage,
      operation: { kind: 'change-password' },
    })

    const password = customPassword ?? generatePagePassword()
    await tx
      .update(page)
      .set({
        visibility: 'password',
        passwordHash: await hashPagePassword(password),
        updatedAt: new Date(),
      })
      .where(eq(page.id, txPage.id))
    await tx.insert(auditEvent).values({
      id: randomUUID(),
      userId: viewer.userId,
      action: 'password-reroll',
      collectionSlug: route.collectionSlug,
      fileSlug: route.fileSlug,
      contentHash: txPage.contentHash,
    })

    return pageResponse({
      collectionSlug: route.collectionSlug,
      fileSlug: route.fileSlug,
      title: txPage.title,
      visibility: 'password',
      password,
    })
  })

  return jsonResponse(result)
}

async function deletePage(request: Request, route: PageRoute): Promise<Response> {
  const { viewer } = await authenticatedViewer(request)
  const storageDir = getDbConfig().storageDir
  let rollbackBlob: (() => Promise<void>) | undefined
  return await withPagePathLocks(
    () => getPool().connect(),
    [route],
    async (connection) => {
      const lockedDb = drizzle(connection, { schema })
      try {
        await lockedDb.transaction(async (tx) => {
          const txCollection = await tx.query.collection.findFirst({
            where: eq(collection.slug, route.collectionSlug),
          })
          const txPage = await tx.query.page.findFirst({
            where: and(
              eq(page.collectionSlug, route.collectionSlug),
              eq(page.fileSlug, route.fileSlug),
              isNull(page.archivedAt),
            ),
          })
          if (!txCollection || !txPage) {
            throw new HttpError(404, 'page not found')
          }
          assertMutationAllowed({
            user: viewer,
            collection: txCollection,
            page: txPage,
            operation: { kind: 'unpublish' },
          })

          const blob = await archiveBlob(storageDir, route.collectionSlug, route.fileSlug)
          rollbackBlob = blob.rollback
          await tx
            .update(page)
            .set({ archivedAt: new Date(), updatedAt: new Date() })
            .where(eq(page.id, txPage.id))
          await tx.insert(auditEvent).values({
            id: randomUUID(),
            userId: viewer.userId,
            action: 'unpublish',
            collectionSlug: route.collectionSlug,
            fileSlug: route.fileSlug,
            contentHash: txPage.contentHash,
          })
        })
        rollbackBlob = undefined
        return jsonResponse({ ok: true })
      } catch (error) {
        return await rollbackBlobPreservingError(error, rollbackBlob, 'deletePage')
      }
    },
  )
}

export async function collectionsIndexEndpoint(request: Request): Promise<Response> {
  try {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'method not allowed' }, 405)
    }
    const { viewer } = await authenticatedViewer(request)
    const allowedDomains = getDbConfig().allowedDomains
    const rows = await getDb()
      .select({
        collection,
        page,
      })
      .from(page)
      .innerJoin(collection, eq(page.collectionSlug, collection.slug))
      .where(isNull(page.archivedAt))
      .limit(MAX_LIST_ROWS + 1)

    const hasMore = rows.length > MAX_LIST_ROWS
    const boundedRows = hasMore ? rows.slice(0, MAX_LIST_ROWS) : rows

    const collections = new Map<string, CollectionRow>()
    for (const row of boundedRows) {
      const decision = decideAcl(viewer, pageAcl(row.page), collectionAcl(row.collection), {
        allowedDomains,
      })
      if (decision.allowed) {
        collections.set(row.collection.slug, row.collection)
      }
    }

    return jsonResponse({
      collections: [...collections.values()].map((row) => ({
        slug: row.slug,
        title: row.title,
        defaultVisibility: collectionAcl(row).defaultVisibility,
      })),
      hasMore,
    })
  } catch (error) {
    return jsonErrorResponse('collectionsIndexEndpoint', error, request)
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
    return jsonResponse({ error: 'method not allowed' }, 405)
  } catch (error) {
    return jsonErrorResponse('collectionsEndpoint', error, request)
  }
}

async function listCollectionPages(
  request: Request,
  collectionSlug: CollectionSlug,
): Promise<Response> {
  const { viewer } = await authenticatedViewer(request)
  const db = getDb()
  const allowedDomains = getDbConfig().allowedDomains
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
    limit: MAX_LIST_ROWS + 1,
  })
  const hasMore = rows.length > MAX_LIST_ROWS
  const boundedRows = hasMore ? rows.slice(0, MAX_LIST_ROWS) : rows

  return jsonResponse({
    pages: boundedRows
      .filter(
        (row) =>
          decideAcl(viewer, pageAcl(row), collectionAcl(existingCollection), {
            allowedDomains,
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
    hasMore,
  })
}

async function patchCollection(
  request: Request,
  collectionSlug: CollectionSlug,
): Promise<Response> {
  const { viewer } = await authenticatedViewer(request)
  const input = await readMutationJson(request)
  const defaultVisibility = parseOptionalCollectionDefaultVisibilityPatch(input.defaultVisibility)
  if (defaultVisibility === null) {
    throw new HttpError(400, 'defaultVisibility cannot be null')
  }
  const title = input.title === null ? null : parseOptionalString(input.title, 'title')
  if (defaultVisibility === undefined && title === undefined) {
    throw new HttpError(400, 'at least one patch field is required')
  }

  const updated = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${collectionSlug}))`)
    const existingCollection = await tx.query.collection.findFirst({
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

    return {
      slug: collectionSlug,
      title: title === undefined ? existingCollection.title : title,
      defaultVisibility: defaultVisibility ?? existingCollectionDefault,
    }
  })

  return jsonResponse({ collection: updated })
}
