import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'

import { decideAcl, parseCollectionSlug, parseFileSlug } from '@press/core'
import { and, eq, isNull } from 'drizzle-orm'

import { auth } from '../auth/server'
import { db, dbConfig } from '../db/client'
import { collection, page, user } from '../db/schema'
import { pageBlobPath } from './storage'
import { deniedAclResponse, servedPageResponse } from './serveAcl'
import { verifyPagePassword } from './passwords'

import type {
  AclViewer,
  AuthenticatedViewer,
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
): Promise<boolean> {
  const password = parseBasicPassword(request)
  if (!password || !passwordHash) {
    return false
  }
  try {
    return await verifyPagePassword(password, passwordHash)
  } catch {
    return false
  }
}

async function viewerForRequest(request: Request, row: PageRow): Promise<AclViewer> {
  const session = await auth.api.getSession({ headers: request.headers })
  if (session) {
    const dbUser = await db.query.user.findFirst({
      where: eq(user.id, session.user.id),
    })
    if (dbUser) {
      return authenticatedViewer(dbUser)
    }
  }

  if (request.headers.get('authorization')?.toLowerCase().startsWith('basic ')) {
    return {
      kind: 'basic-password',
      verified: await verifyBasicPassword(request, row.passwordHash),
    }
  }

  return { kind: 'anonymous' }
}

async function servedPageEndpointUnchecked(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return servedPageResponse('method not allowed', { status: 405 })
  }

  const route = parseServedPath(request)
  if (!route) {
    return notFound()
  }

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

  const row = rows[0]
  if (!row) {
    return notFound()
  }

  const viewer = await viewerForRequest(request, row.page)
  const decision = decideAcl(viewer, pageAcl(row.page), collectionAcl(row.collection), {
    allowedDomains: dbConfig.allowedDomains,
  })
  if (!decision.allowed) {
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
