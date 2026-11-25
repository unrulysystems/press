import { SlugValidationError, decideAcl, parseCollectionSlug, parseFileSlug } from '@press/core'
import { and, eq, isNull } from 'drizzle-orm'

import { consumeRateLimit } from '../auth/rateLimit'
import { getAuth } from '../auth/server'
import { loadActiveViewerForUserId } from '../auth/sessionViewer'
import { getDb, getDbConfig } from '../db/client'
import { collection, page, pageRedirect } from '../db/schema'
import { BodyTooLargeError, readCappedBodyText } from '../http/readBody'
import { logServerError } from '../http/responses'
import { openPageBlobForRead } from './storage'
import {
  acceptsHtml,
  assertCollectionDefaultVisibility,
  deniedAclResponse,
  passwordGateResponse,
  servedPageResponse,
  viewerFromChannels,
} from './serveAcl'
import {
  PAGE_PASSWORD_COOKIE_TTL_MS,
  pagePasswordCookieName,
  readCookieValue,
  signPagePasswordCookie,
  verifyPagePasswordCookie,
} from './pagePasswordCookie'
import { verifyPagePassword } from './passwords'

import type {
  AclViewer,
  BasicPasswordVerification,
  CollectionAcl,
  CollectionSlug,
  FileSlug,
  PageAcl,
} from '@press/core'
import type { InferSelectModel } from 'drizzle-orm'

type CollectionRow = InferSelectModel<typeof collection>
type PageRow = InferSelectModel<typeof page>

type ServedRoute = {
  readonly collectionSlug: CollectionSlug
  readonly fileSlug: FileSlug
}

const PASSWORD_UNLOCK_BODY_LIMIT_BYTES = 16 * 1024
const PASSWORD_UNLOCK_RATE_WINDOW_MS = 60 * 1000
const PRODUCTION_PASSWORD_UNLOCK_LIMIT_MAX = 30
const NON_PRODUCTION_PASSWORD_UNLOCK_LIMIT_MAX = 10_000

function notFound(): Response {
  return servedPageResponse('not found', { status: 404 })
}

function servedPagePath(route: ServedRoute): string {
  return `/p/${route.collectionSlug}/${route.fileSlug}`
}

async function loadServedRow(
  route: ServedRoute,
): Promise<{ readonly page: PageRow; readonly collection: CollectionRow } | null> {
  const rows = await getDb()
    .select({ page, collection })
    .from(page)
    .innerJoin(collection, eq(page.collectionSlug, collection.slug))
    .where(
      and(
        eq(page.collectionSlug, route.collectionSlug),
        eq(page.fileSlug, route.fileSlug),
        isNull(page.archivedAt),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

async function redirectResponse(route: ServedRoute): Promise<Response | null> {
  const rows = await getDb()
    .select({ page })
    .from(pageRedirect)
    .innerJoin(page, eq(pageRedirect.targetPageId, page.id))
    .where(
      and(
        eq(pageRedirect.sourceCollectionSlug, route.collectionSlug),
        eq(pageRedirect.sourceFileSlug, route.fileSlug),
        isNull(page.archivedAt),
      ),
    )
    .limit(1)
  const target = rows[0]?.page
  if (!target) {
    return null
  }
  const destination = {
    collectionSlug: parseCollectionSlug(target.collectionSlug),
    fileSlug: parseFileSlug(target.fileSlug),
  }
  if (
    destination.collectionSlug === route.collectionSlug &&
    destination.fileSlug === route.fileSlug
  ) {
    return null
  }
  return servedPageResponse(null, {
    status: 308,
    headers: { location: servedPagePath(destination) },
  })
}

function parseServedPath(request: Request): ServedRoute | null {
  let segments: string[]
  try {
    const path = new URL(request.url).pathname
    const raw = path.slice('/p/'.length)
    segments = raw.split('/').map((segment) => decodeURIComponent(segment))
  } catch (error) {
    if (error instanceof URIError) {
      return null
    }
    throw error
  }
  if (segments.length !== 2) {
    return null
  }
  try {
    return {
      collectionSlug: parseCollectionSlug(segments[0] ?? ''),
      fileSlug: parseFileSlug(segments[1] ?? ''),
    }
  } catch (error) {
    if (error instanceof SlugValidationError) {
      return null
    }
    throw error
  }
}

function pageAcl(row: PageRow): PageAcl {
  return {
    collectionSlug: row.collectionSlug,
    fileSlug: row.fileSlug,
    visibility: row.visibility,
    passwordHash: row.passwordHash,
    allowlist: row.allowlist,
  }
}

function collectionAcl(row: CollectionRow): CollectionAcl {
  return {
    slug: row.slug,
    ownerId: row.ownerId,
    defaultVisibility: assertCollectionDefaultVisibility(row.defaultVisibility),
  }
}

function hasBasicAuthorization(request: Request): boolean {
  const authorization = request.headers.get('authorization')
  return /^Basic\s+/i.test(authorization ?? '')
}

function parseBasicPassword(request: Request): string | null {
  const authorization = request.headers.get('authorization')
  const match = /^Basic\s+(.+)$/i.exec(authorization ?? '')
  if (!match) {
    return null
  }
  const encoded = match[1]
  if (!encoded) {
    return null
  }
  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  return separator === -1 ? '' : decoded.slice(separator + 1)
}

async function verifyBasicPassword(
  request: Request,
  row: PageRow,
): Promise<BasicPasswordVerification | undefined> {
  if (!hasBasicAuthorization(request)) {
    return undefined
  }
  const password = parseBasicPassword(request)
  if (!password || !row.passwordHash) {
    return { verified: false }
  }
  return { verified: await verifyPagePassword(password, row.passwordHash) }
}

async function resolvePagePasswordChannel(
  request: Request,
  row: PageRow,
): Promise<BasicPasswordVerification | undefined> {
  const config = getDbConfig()
  const cookie = readCookieValue(request.headers.get('cookie'), pagePasswordCookieName(row.id))
  if (
    verifyPagePasswordCookie(config.betterAuthSecret, row.id, cookie, Date.now(), row.passwordHash)
  ) {
    return { verified: true }
  }
  return await verifyBasicPassword(request, row)
}

async function viewerForRequest(request: Request, row: PageRow): Promise<AclViewer> {
  const basicPassword =
    row.visibility === 'password' ? await resolvePagePasswordChannel(request, row) : undefined
  const session = await getAuth().api.getSession({ headers: request.headers })
  if (session) {
    const authenticated = await loadActiveViewerForUserId(
      getDb(),
      session.user.id,
      getDbConfig().adminEmails,
    )
    if (authenticated) {
      return viewerFromChannels({ authenticated, basicPassword })
    }
  }

  return viewerFromChannels({ basicPassword })
}

async function servedPageEndpointUnchecked(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return servedPageResponse('method not allowed', { status: 405 })
  }

  const route = parseServedPath(request)
  if (!route) {
    return notFound()
  }

  const row = await loadServedRow(route)
  if (!row) {
    return (await redirectResponse(route)) ?? notFound()
  }

  const config = getDbConfig()
  const viewer = await viewerForRequest(request, row.page)
  const decision = decideAcl(viewer, pageAcl(row.page), collectionAcl(row.collection), {
    allowedDomains: config.allowedDomains,
  })
  if (!decision.allowed) {
    if (
      (decision.reason === 'password-required' || decision.reason === 'password-invalid') &&
      acceptsHtml(request)
    ) {
      return passwordGateResponse({
        title: row.page.title,
        actionPath: servedPagePath(route),
        ...(decision.reason === 'password-invalid' ? { error: 'Incorrect password.' } : {}),
        status: decision.reason === 'password-invalid' ? 401 : 200,
      })
    }
    return deniedAclResponse(request, decision)
  }

  const storedCollectionSlug = parseCollectionSlug(row.page.collectionSlug)
  const storedFileSlug = parseFileSlug(row.page.fileSlug)
  const body = await openPageBlobForRead(config.storageDir, storedCollectionSlug, storedFileSlug)

  return servedPageResponse(body)
}

export async function servedPageEndpoint(request: Request): Promise<Response> {
  try {
    return await servedPageEndpointUnchecked(request)
  } catch (error) {
    logServerError('servedPageEndpoint', error, request)
    return servedPageResponse('internal server error', { status: 500 })
  }
}

function serializeUnlockCookie(pageId: string, value: string, path: string): string {
  const maxAgeSeconds = Math.floor(PAGE_PASSWORD_COOKIE_TTL_MS / 1000)
  const parts = [
    `${pagePasswordCookieName(pageId)}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (getDbConfig().nodeEnv === 'production') {
    parts.push('Secure')
  }
  return parts.join('; ')
}

async function servedPagePasswordUnlock(request: Request, route: ServedRoute): Promise<Response> {
  const row = await loadServedRow(route)
  if (!row || row.page.visibility !== 'password') {
    return notFound()
  }
  const config = getDbConfig()
  const allowed = await consumeRateLimit(getDb(), {
    identifier: `cli:page-pw:${row.page.id}`,
    max:
      config.nodeEnv === 'production'
        ? PRODUCTION_PASSWORD_UNLOCK_LIMIT_MAX
        : NON_PRODUCTION_PASSWORD_UNLOCK_LIMIT_MAX,
    windowMs: PASSWORD_UNLOCK_RATE_WINDOW_MS,
    now: Date.now(),
  })
  if (!allowed) {
    return passwordGateResponse({
      title: row.page.title,
      actionPath: servedPagePath(route),
      error: 'Too many attempts. Please try again in a minute.',
      status: 429,
    })
  }
  const bodyText = await readCappedBodyText(request, PASSWORD_UNLOCK_BODY_LIMIT_BYTES)
  const password = new URLSearchParams(bodyText).get('password') ?? ''
  const actionPath = servedPagePath(route)
  const verified = row.page.passwordHash
    ? await verifyPagePassword(password, row.page.passwordHash)
    : false
  if (!verified) {
    return passwordGateResponse({
      title: row.page.title,
      actionPath,
      error: 'Incorrect password.',
      status: 401,
    })
  }
  const expiryMs = Date.now() + PAGE_PASSWORD_COOKIE_TTL_MS
  const value = signPagePasswordCookie(
    config.betterAuthSecret,
    row.page.id,
    expiryMs,
    row.page.passwordHash,
  )
  return servedPageResponse(null, {
    status: 303,
    headers: {
      location: actionPath,
      'set-cookie': serializeUnlockCookie(row.page.id, value, actionPath),
    },
  })
}

export async function servedPagePasswordEndpoint(request: Request): Promise<Response> {
  try {
    if (request.method !== 'POST') {
      return servedPageResponse('method not allowed', { status: 405 })
    }
    const route = parseServedPath(request)
    if (!route) {
      return notFound()
    }
    return await servedPagePasswordUnlock(request, route)
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return servedPageResponse(error.message, { status: 413 })
    }
    logServerError('servedPagePasswordEndpoint', error, request)
    return servedPageResponse('internal server error', { status: 500 })
  }
}
