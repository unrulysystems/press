import { decideAcl, parseCollectionSlug } from '@press/core'
import { and, desc, eq, isNull } from 'drizzle-orm'

import { auth } from '../auth/server'
import { db, dbConfig } from '../db/client'
import { collection, page, user } from '../db/schema'

import type {
  AclViewer,
  AuthenticatedViewer,
  CollectionAcl,
  CollectionDefaultVisibility,
  CollectionSlug,
  PageAcl,
  PageVisibility,
} from '@press/core'
import type { InferSelectModel } from 'drizzle-orm'

type CollectionRow = InferSelectModel<typeof collection>
type PageRow = InferSelectModel<typeof page>
type UserRow = InferSelectModel<typeof user>

export type MagazineViewer = {
  readonly authenticated: boolean
  readonly email?: string
}

export type MagazineEntry = {
  readonly title: string
  readonly collectionSlug: string
  readonly collectionTitle: string
  readonly fileSlug: string
  readonly href: string
  readonly publisher: string
  readonly publishedAt: string
  readonly dateLabel: string
  readonly visibility: PageVisibility
  readonly locked: boolean
}

export type MagazineFeed = {
  readonly viewer: MagazineViewer
  readonly entries: readonly MagazineEntry[]
}

export type MagazineCollection = {
  readonly viewer: MagazineViewer
  readonly collection: {
    readonly slug: string
    readonly title: string
  }
  readonly entries: readonly MagazineEntry[]
}

function authenticatedViewer(row: Pick<UserRow, 'id' | 'email' | 'role'>): AuthenticatedViewer {
  return {
    kind: 'authenticated',
    userId: row.id,
    email: row.email,
    role: row.role,
  }
}

function magazineViewer(viewer: AclViewer): MagazineViewer {
  if (viewer.kind === 'anonymous') {
    return { authenticated: false }
  }
  return { authenticated: true, email: viewer.email }
}

async function viewerForRequest(request: Request | undefined): Promise<AclViewer> {
  if (!request) {
    return { kind: 'anonymous' }
  }

  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) {
    return { kind: 'anonymous' }
  }

  const dbUser = await db.query.user.findFirst({
    where: eq(user.id, session.user.id),
  })
  return dbUser ? authenticatedViewer(dbUser) : { kind: 'anonymous' }
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

function resolvedVisibility(row: PageRow, collectionRow: CollectionRow): PageVisibility {
  return (
    row.visibility ?? (collectionRow.defaultVisibility as CollectionDefaultVisibility) ?? 'default'
  )
}

function canListPasswordPage(viewer: AclViewer, pageRow: PageRow, collectionRow: CollectionRow) {
  if (viewer.kind === 'anonymous') {
    return false
  }

  const orgGatePage: PageAcl = {
    ...pageAcl(pageRow),
    visibility: 'default',
    passwordHash: null,
  }
  const orgGateCollection: CollectionAcl = {
    ...collectionAcl(collectionRow),
    defaultVisibility: 'default',
  }
  return decideAcl(viewer, orgGatePage, orgGateCollection, {
    allowedDomains: dbConfig.allowedDomains,
  }).allowed
}

function canListPage(viewer: AclViewer, pageRow: PageRow, collectionRow: CollectionRow): boolean {
  const decision = decideAcl(viewer, pageAcl(pageRow), collectionAcl(collectionRow), {
    allowedDomains: dbConfig.allowedDomains,
  })
  if (decision.allowed) {
    return true
  }
  return resolvedVisibility(pageRow, collectionRow) === 'password'
    ? canListPasswordPage(viewer, pageRow, collectionRow)
    : false
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value)
}

function toEntry(row: {
  readonly page: PageRow
  readonly collection: CollectionRow
  readonly publisher: Pick<UserRow, 'name' | 'email'>
}): MagazineEntry {
  const visibility = resolvedVisibility(row.page, row.collection)
  return {
    title: row.page.title,
    collectionSlug: row.collection.slug,
    collectionTitle: row.collection.title ?? row.collection.slug,
    fileSlug: row.page.fileSlug,
    href: `/p/${row.page.collectionSlug}/${row.page.fileSlug}`,
    publisher: row.publisher.name || row.publisher.email,
    publishedAt: row.page.publishedAt.toISOString(),
    dateLabel: formatDate(row.page.publishedAt),
    visibility,
    locked: visibility === 'password',
  }
}

async function readableRows(viewer: AclViewer, collectionSlug?: CollectionSlug) {
  const where = collectionSlug
    ? and(eq(page.collectionSlug, collectionSlug), isNull(page.archivedAt))
    : isNull(page.archivedAt)

  const rows = await db
    .select({
      page,
      collection,
      publisher: user,
    })
    .from(page)
    .innerJoin(collection, eq(page.collectionSlug, collection.slug))
    .innerJoin(user, eq(page.publishedBy, user.id))
    .where(where)
    .orderBy(desc(page.publishedAt), desc(page.updatedAt))

  return rows.filter((row) => canListPage(viewer, row.page, row.collection))
}

export async function loadMagazineFeed(request?: Request): Promise<MagazineFeed> {
  const viewer = await viewerForRequest(request)
  const rows = await readableRows(viewer)
  return {
    viewer: magazineViewer(viewer),
    entries: rows.map(toEntry),
  }
}

export async function loadMagazineCollection(
  rawCollectionSlug: string,
  request?: Request,
): Promise<MagazineCollection | null> {
  let collectionSlug: CollectionSlug
  try {
    collectionSlug = parseCollectionSlug(rawCollectionSlug)
  } catch {
    return null
  }

  const collectionRow = await db.query.collection.findFirst({
    where: eq(collection.slug, collectionSlug),
  })
  if (!collectionRow) {
    return null
  }

  const viewer = await viewerForRequest(request)
  const rows = await readableRows(viewer, collectionSlug)
  if (rows.length === 0) {
    return null
  }

  return {
    viewer: magazineViewer(viewer),
    collection: {
      slug: collectionRow.slug,
      title: collectionRow.title ?? collectionRow.slug,
    },
    entries: rows.map(toEntry),
  }
}
