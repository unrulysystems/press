import { describe, expect, test } from 'bun:test'
import { decideAcl } from '@press/core'
import type { CollectionAcl, CollectionDefaultVisibility, PageAcl } from '@press/core'
import type { InferSelectModel } from 'drizzle-orm'

import { auditAction, collection, page, pageRedirect } from './schema'

type CollectionAclRow = Omit<
  Pick<InferSelectModel<typeof collection>, 'slug' | 'ownerId' | 'defaultVisibility'>,
  'defaultVisibility'
> & {
  readonly defaultVisibility: CollectionDefaultVisibility
}
type PageAclRow = Pick<
  InferSelectModel<typeof page>,
  'collectionSlug' | 'fileSlug' | 'visibility' | 'allowlist'
>

function collectionAclFromRow(row: CollectionAclRow): CollectionAcl {
  return {
    slug: row.slug,
    ownerId: row.ownerId,
    defaultVisibility: row.defaultVisibility,
  }
}

function pageAclFromRow(row: PageAclRow): PageAcl {
  return {
    collectionSlug: row.collectionSlug,
    fileSlug: row.fileSlug,
    visibility: row.visibility,
    allowlist: row.allowlist,
  }
}

describe('page visibility persistence shape', () => {
  const pageRow: PageAclRow = {
    collectionSlug: 'reports',
    fileSlug: 'launch.html',
    visibility: null,
    allowlist: [],
  }

  test('preserves unset page visibility so collection default can apply', () => {
    const collectionRow: CollectionAclRow = {
      slug: 'reports',
      ownerId: 'user-owner',
      defaultVisibility: 'private',
    }

    expect(
      decideAcl(
        { kind: 'anonymous' },
        pageAclFromRow(pageRow),
        collectionAclFromRow(collectionRow),
        { allowedDomains: ['send.it'] },
      ),
    ).toEqual({
      allowed: false,
      reason: 'authentication-required',
      resolvedVisibility: 'private',
    })
  })

  test('uses the collection default row value when both inserts omitted visibility', () => {
    const collectionRow: CollectionAclRow = {
      slug: 'reports',
      ownerId: 'user-owner',
      defaultVisibility: 'default',
    }

    expect(
      decideAcl(
        { kind: 'anonymous' },
        pageAclFromRow(pageRow),
        collectionAclFromRow(collectionRow),
        { allowedDomains: ['send.it'] },
      ),
    ).toEqual({
      allowed: false,
      reason: 'authentication-required',
      resolvedVisibility: 'default',
    })
  })
})

describe('page redirect persistence shape', () => {
  test('stores one permanent source path for a stable target page identity', () => {
    expect(auditAction.enumValues).toContain('move')
    expect(pageRedirect.sourceCollectionSlug.name).toBe('sourceCollectionSlug')
    expect(pageRedirect.sourceFileSlug.name).toBe('sourceFileSlug')
    expect(pageRedirect.targetPageId.name).toBe('targetPageId')
    expect(pageRedirect.kind.enumValues).toEqual(['permanent'])
    expect(pageRedirect.createdBy.name).toBe('createdBy')
  })
})
