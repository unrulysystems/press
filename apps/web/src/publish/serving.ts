import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'

import { decideAcl, parseCollectionSlug, parseFileSlug } from '@press/core'
import { and, eq, isNull } from 'drizzle-orm'

import { auth } from '../auth/server'
import { db, dbConfig } from '../db/client'
import { collection, page, user } from '../db/schema'
import { pageBlobPath } from './storage'
import {
  acceptsHtml,
  deniedAclResponse,
  passwordGateResponse,
  servedPageResponse,
  viewerFromChannels,
} from './serveAcl'
import {
  PAGE_PASSWORD_COOKIE_TTL_MS,
  pagePasswordCookieName,
  signPagePasswordCookie,
  verifyPagePasswordCookie,
} from './pagePasswordCookie'
import { verifyPagePassword } from './passwords'

import type {
  AclViewer,
  AuthenticatedViewer,
  BasicPasswordVerification,
  CollectionAcl,
  CollectionDefaultVisibility,
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

function notFound(): Response {
  return servedPageResponse('not found', { status: 404 })
}

function servedPagePath(route: ServedRoute): string {
  return `/p/${route.collectionSlug}/${route.fileSlug}`
}

async function loadServedRow(
  route: ServedRoute,
): Promise<{ readonly page: PageRow; readonly collection: CollectionRow } | null> {
  const rows = await db
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

function parseServedPath(request: Request): ServedRoute | null {
  try {
    const path = new URL(request.url).pathname
    const raw = path.slice('/p/'.length)
    const segments = raw.split('/').map((segment) => decodeURIComponent(segment))
    if (segments.length !== 2) {
      return null
    }
    return {
      collectionSlug: parseCollectionSlug(segments[0] ?? ''),
      fileSlug: parseFileSlug(segments[1] ?? ''),
    }
  } catch {
    return null
  }
}

function authenticatedViewer(
  row: Pick<InferSelectModel<typeof user>, 'id' | 'email' | 'role'>,
): AuthenticatedViewer {
  return {
    kind: 'authenticated',
    userId: row.id,
    email: row.email,
    role: row.role,
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
    defaultVisibility: row.defaultVisibility as CollectionDefaultVisibility,
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
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    return separator === -1 ? '' : decoded.slice(separator + 1)
  } catch {
    return null
  }
}

async function verifyBasicPassword(
  request: Request,
  passwordHash: string | null,
): Promise<BasicPasswordVerification | undefined> {
  if (!hasBasicAuthorization(request)) {
    return undefined
  }
  const password = parseBasicPassword(request)
  if (!password || !passwordHash) {
    return { verified: false }
  }
  try {
    return { verified: await verifyPagePassword(password, passwordHash) }
  } catch {
    return { verified: false }
  }
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie')
  if (!header) {
    return undefined
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) {
      continue
    }
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  return undefined
}

// A valid unlock cookie (browser reader who already entered the password) or Basic
// credentials (programmatic client) both satisfy the password channel. The cookie is
// checked first so browsers do not re-submit the password on every request.
async function resolvePagePasswordChannel(
  request: Request,
  row: PageRow,
): Promise<BasicPasswordVerification | undefined> {
  const cookie = readCookie(request, pagePasswordCookieName(row.id))
  if (verifyPagePasswordCookie(dbConfig.betterAuthSecret, row.id, cookie, Date.now())) {
    return { verified: true }
  }
  return await verifyBasicPassword(request, row.passwordHash)
}

async function viewerForRequest(request: Request, row: PageRow): Promise<AclViewer> {
  const basicPassword =
    row.visibility === 'password' ? await resolvePagePasswordChannel(request, row) : undefined
  const session = await auth.api.getSession({ headers: request.headers })
  if (session) {
    const dbUser = await db.query.user.findFirst({
      where: eq(user.id, session.user.id),
    })
    if (dbUser) {
      return viewerFromChannels({ authenticated: authenticatedViewer(dbUser), basicPassword })
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
    return notFound()
  }

  const viewer = await viewerForRequest(request, row.page)
  const decision = decideAcl(viewer, pageAcl(row.page), collectionAcl(row.collection), {
    allowedDomains: dbConfig.allowedDomains,
  })
  if (!decision.allowed) {
    // A browser reader of a locked password page gets the branded entry page (200 with
    // no body leak); programmatic clients keep the Basic challenge (REQ-ACL-002 / SRV-004).
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
  const path = pageBlobPath(dbConfig.storageDir, storedCollectionSlug, storedFileSlug)
  await stat(path).catch((error) => {
    throw new Error(
      `stored page blob missing for ${row.page.collectionSlug}/${row.page.fileSlug}`,
      {
        cause: error,
      },
    )
  })
  const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>

  return servedPageResponse(body)
}

export async function servedPageEndpoint(request: Request): Promise<Response> {
  try {
    return await servedPageEndpointUnchecked(request)
  } catch {
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
  // Secure in production; localnet is plain http so the cookie must still be sent.
  if (dbConfig.nodeEnv === 'production') {
    parts.push('Secure')
  }
  return parts.join('; ')
}

// POST /p/:collection/:file — the branded gate's form target. This is a read-side
// unlock (it sets a page-scoped cookie), NOT a page mutation: INV-1 (mutations are
// Bearer-only) is unaffected because it never changes page state.
async function servedPagePasswordUnlock(request: Request, route: ServedRoute): Promise<Response> {
  const row = await loadServedRow(route)
  if (!row || row.page.visibility !== 'password') {
    // The unlock endpoint only applies to password pages; do not reveal others.
    return notFound()
  }
  // The branded gate posts application/x-www-form-urlencoded; parse without FormData.
  // A genuine body-read failure propagates to the endpoint's 500 handler rather than
  // being masked as a wrong password — an empty body still parses to no password (401).
  const bodyText = await request.text()
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
  const value = signPagePasswordCookie(dbConfig.betterAuthSecret, row.page.id, expiryMs)
  return new Response(null, {
    status: 303,
    headers: {
      location: actionPath,
      'set-cookie': serializeUnlockCookie(row.page.id, value, actionPath),
      'cache-control': 'no-store',
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
  } catch {
    return servedPageResponse('internal server error', { status: 500 })
  }
}
