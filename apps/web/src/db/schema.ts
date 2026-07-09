import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const userRole = pgEnum('user_role', ['user', 'admin'])
export const pageVisibility = pgEnum('page_visibility', [
  'default',
  'public',
  'password',
  'private',
])
export const auditAction = pgEnum('audit_action', [
  'publish',
  'overwrite',
  'unpublish',
  'visibility-change',
  'password-reroll',
  'token-revoke',
  'move',
])
export const pageRedirectKind = pgEnum('page_redirect_kind', ['permanent'])

export type MoveAuditDetails = {
  readonly kind: 'move'
  readonly source: {
    readonly collection: string
    readonly file: string
  }
  readonly destination: {
    readonly collection: string
    readonly file: string
  }
  readonly redirect: 'permanent' | 'none'
}

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().defaultNow(),
  role: userRole('role').notNull().default('user'),
  banned: boolean('banned').notNull().default(false),
  banReason: text('banReason'),
  banExpires: timestamp('banExpires', { mode: 'date' }),
})

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().defaultNow(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    impersonatedBy: text('impersonatedBy'),
  },
  (table) => [index('session_user_id_idx').on(table.userId)],
)

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: timestamp('accessTokenExpiresAt', { mode: 'date' }),
    refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt', { mode: 'date' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('account_user_id_idx').on(table.userId)],
)

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
)

export const apiToken = pgTable(
  'apiToken',
  {
    id: text('id').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('tokenHash').notNull(),
    lastUsedAt: timestamp('lastUsedAt', { mode: 'date' }),
    revokedAt: timestamp('revokedAt', { mode: 'date' }),
    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('api_token_hash_idx').on(table.tokenHash),
    index('api_token_user_id_idx').on(table.userId),
  ],
)

export const collection = pgTable('collection', {
  slug: text('slug').primaryKey(),
  ownerId: text('ownerId')
    .notNull()
    .references(() => user.id, { onDelete: 'restrict' }),
  title: text('title'),
  defaultVisibility: pageVisibility('defaultVisibility').notNull().default('default'),
  createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
})

export const page = pgTable(
  'page',
  {
    id: text('id').primaryKey(),
    collectionSlug: text('collectionSlug')
      .notNull()
      .references(() => collection.slug, { onDelete: 'cascade' }),
    fileSlug: text('fileSlug').notNull(),
    title: text('title').notNull(),
    visibility: pageVisibility('visibility'),
    passwordHash: text('passwordHash'),
    allowlist: text('allowlist')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    contentHash: text('contentHash').notNull(),
    sizeBytes: integer('sizeBytes').notNull(),
    publishedBy: text('publishedBy')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    publishedAt: timestamp('publishedAt', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().defaultNow(),
    archivedAt: timestamp('archivedAt', { mode: 'date' }),
  },
  (table) => [
    uniqueIndex('page_collection_file_idx').on(table.collectionSlug, table.fileSlug),
    index('page_collection_slug_idx').on(table.collectionSlug),
    index('page_published_at_idx').on(table.publishedAt),
  ],
)

export const pageRedirect = pgTable(
  'pageRedirect',
  {
    sourceCollectionSlug: text('sourceCollectionSlug')
      .notNull()
      .references(() => collection.slug, { onDelete: 'restrict' }),
    sourceFileSlug: text('sourceFileSlug').notNull(),
    targetPageId: text('targetPageId')
      .notNull()
      .references(() => page.id, { onDelete: 'cascade' }),
    kind: pageRedirectKind('kind').notNull().default('permanent'),
    createdBy: text('createdBy')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'page_redirect_source_pk',
      columns: [table.sourceCollectionSlug, table.sourceFileSlug],
    }),
    index('page_redirect_target_page_id_idx').on(table.targetPageId),
  ],
)

export const auditEvent = pgTable(
  'auditEvent',
  {
    id: text('id').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    action: auditAction('action').notNull(),
    collectionSlug: text('collectionSlug').references(() => collection.slug, {
      onDelete: 'restrict',
    }),
    fileSlug: text('fileSlug'),
    contentHash: text('contentHash'),
    details: jsonb('details').$type<MoveAuditDetails>(),
    createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_event_user_id_idx').on(table.userId),
    index('audit_event_collection_slug_idx').on(table.collectionSlug),
    index('audit_event_created_at_idx').on(table.createdAt),
  ],
)

export const schema = {
  account,
  apiToken,
  auditEvent,
  collection,
  page,
  pageRedirect,
  session,
  user,
  verification,
}
