import { describe, expect, test } from 'bun:test'

import { decideAcl } from './index'

import type {
  AclConfig,
  AclDenyReason,
  AclOperation,
  AclViewer,
  CollectionAcl,
  PageAcl,
} from './index'

const config: AclConfig = {
  allowedDomains: ['send.it'],
  operation: { kind: 'read' },
}

const collection: CollectionAcl = {
  slug: 'reports',
  ownerId: 'user-owner',
}

const pageBase: PageAcl = {
  collectionSlug: 'reports',
  fileSlug: 'launch.html',
  visibility: 'default',
  passwordHash: 'argon2-hash',
  allowlist: ['external@example.net'],
}

const pageWithoutVisibility: PageAcl = {
  collectionSlug: pageBase.collectionSlug,
  fileSlug: pageBase.fileSlug,
  allowlist: pageBase.allowlist,
}

const viewers = {
  anonymous: { kind: 'anonymous' },
  passwordVerified: { kind: 'anonymous', basicPassword: { verified: true } },
  passwordRejected: { kind: 'anonymous', basicPassword: { verified: false } },
  wrongDomainPasswordVerified: {
    kind: 'authenticated',
    userId: 'user-wrong-domain',
    email: 'wrong@example.com',
    role: 'user',
    basicPassword: { verified: true },
  },
  wrongDomainPasswordRejected: {
    kind: 'authenticated',
    userId: 'user-wrong-domain',
    email: 'wrong@example.com',
    role: 'user',
    basicPassword: { verified: false },
  },
  ownerPasswordRejected: {
    kind: 'authenticated',
    userId: 'user-owner',
    email: 'owner@send.it',
    role: 'user',
    basicPassword: { verified: false },
  },
  owner: {
    kind: 'authenticated',
    userId: 'user-owner',
    email: 'owner@send.it',
    role: 'user',
  },
  admin: {
    kind: 'authenticated',
    userId: 'user-admin',
    email: 'admin@send.it',
    role: 'admin',
  },
  domainUser: {
    kind: 'authenticated',
    userId: 'user-second',
    email: 'second@send.it',
    role: 'user',
  },
  wrongDomain: {
    kind: 'authenticated',
    userId: 'user-wrong-domain',
    email: 'wrong@example.com',
    role: 'user',
  },
  externalAllowlisted: {
    kind: 'authenticated',
    userId: 'user-external',
    email: 'external@example.net',
    role: 'user',
  },
} satisfies Record<string, AclViewer>

type ReadRow = {
  readonly visibility: NonNullable<PageAcl['visibility']>
  readonly viewer: keyof typeof viewers
  readonly expected: 'allow' | AclDenyReason
}

const readMatrix = [
  { visibility: 'public', viewer: 'anonymous', expected: 'allow' },
  { visibility: 'public', viewer: 'passwordVerified', expected: 'allow' },
  { visibility: 'public', viewer: 'passwordRejected', expected: 'allow' },
  { visibility: 'public', viewer: 'owner', expected: 'allow' },
  { visibility: 'public', viewer: 'admin', expected: 'allow' },
  { visibility: 'public', viewer: 'domainUser', expected: 'allow' },
  { visibility: 'public', viewer: 'wrongDomain', expected: 'allow' },
  { visibility: 'public', viewer: 'externalAllowlisted', expected: 'allow' },

  { visibility: 'default', viewer: 'anonymous', expected: 'authentication-required' },
  { visibility: 'default', viewer: 'passwordVerified', expected: 'authentication-required' },
  { visibility: 'default', viewer: 'passwordRejected', expected: 'authentication-required' },
  { visibility: 'default', viewer: 'owner', expected: 'allow' },
  { visibility: 'default', viewer: 'admin', expected: 'allow' },
  { visibility: 'default', viewer: 'domainUser', expected: 'allow' },
  { visibility: 'default', viewer: 'wrongDomain', expected: 'domain-not-allowed' },
  { visibility: 'default', viewer: 'externalAllowlisted', expected: 'domain-not-allowed' },

  { visibility: 'private', viewer: 'anonymous', expected: 'authentication-required' },
  { visibility: 'private', viewer: 'passwordVerified', expected: 'authentication-required' },
  { visibility: 'private', viewer: 'passwordRejected', expected: 'authentication-required' },
  { visibility: 'private', viewer: 'owner', expected: 'allow' },
  { visibility: 'private', viewer: 'admin', expected: 'allow' },
  { visibility: 'private', viewer: 'domainUser', expected: 'email-not-allowlisted' },
  { visibility: 'private', viewer: 'wrongDomain', expected: 'email-not-allowlisted' },
  { visibility: 'private', viewer: 'externalAllowlisted', expected: 'allow' },

  { visibility: 'password', viewer: 'anonymous', expected: 'password-required' },
  { visibility: 'password', viewer: 'passwordVerified', expected: 'allow' },
  { visibility: 'password', viewer: 'passwordRejected', expected: 'password-invalid' },
  { visibility: 'password', viewer: 'wrongDomainPasswordVerified', expected: 'allow' },
  { visibility: 'password', viewer: 'wrongDomainPasswordRejected', expected: 'password-invalid' },
  { visibility: 'password', viewer: 'ownerPasswordRejected', expected: 'allow' },
  { visibility: 'password', viewer: 'owner', expected: 'allow' },
  { visibility: 'password', viewer: 'admin', expected: 'allow' },
  { visibility: 'password', viewer: 'domainUser', expected: 'password-required' },
  { visibility: 'password', viewer: 'wrongDomain', expected: 'password-required' },
  { visibility: 'password', viewer: 'externalAllowlisted', expected: 'password-required' },
] satisfies readonly ReadRow[]

describe('decideAcl read matrix', () => {
  test.each(readMatrix)('$visibility read by $viewer -> $expected', (row) => {
    const decision = decideAcl(
      viewers[row.viewer],
      { ...pageBase, visibility: row.visibility },
      collection,
      config,
    )

    if (row.expected === 'allow') {
      expect(decision).toEqual({ allowed: true, resolvedVisibility: row.visibility })
      return
    }

    expect(decision).toEqual({
      allowed: false,
      reason: row.expected,
      resolvedVisibility: row.visibility,
    })
  })
})

describe('decideAcl visibility fallback', () => {
  test('uses page visibility before collection default before default', () => {
    expect(
      decideAcl(
        viewers.anonymous,
        { ...pageBase, visibility: 'public' },
        { ...collection, defaultVisibility: 'private' },
        config,
      ),
    ).toEqual({ allowed: true, resolvedVisibility: 'public' })

    expect(
      decideAcl(
        viewers.anonymous,
        pageWithoutVisibility,
        { ...collection, defaultVisibility: 'public' },
        config,
      ),
    ).toEqual({ allowed: true, resolvedVisibility: 'public' })

    expect(decideAcl(viewers.anonymous, pageWithoutVisibility, collection, config)).toEqual({
      allowed: false,
      reason: 'authentication-required',
      resolvedVisibility: 'default',
    })
  })
})

describe('decideAcl private allowlists', () => {
  test('allows exact external email matches without allowing the whole external domain', () => {
    const page: PageAcl = {
      ...pageBase,
      visibility: 'private',
      allowlist: ['external@example.net'],
    }

    expect(decideAcl(viewers.externalAllowlisted, page, collection, config)).toEqual({
      allowed: true,
      resolvedVisibility: 'private',
    })
    expect(
      decideAcl(
        { kind: 'authenticated', userId: 'external-two', email: 'other@example.net', role: 'user' },
        page,
        collection,
        config,
      ),
    ).toEqual({
      allowed: false,
      reason: 'email-not-allowlisted',
      resolvedVisibility: 'private',
    })
  })
})

describe('decideAcl password material', () => {
  test('denies basic-auth viewers when password visibility has no hash', () => {
    expect(
      decideAcl(
        viewers.passwordVerified,
        { ...pageBase, visibility: 'password', passwordHash: null },
        collection,
        config,
      ),
    ).toEqual({
      allowed: false,
      reason: 'password-invalid',
      resolvedVisibility: 'password',
    })
  })
})

describe('decideAcl mutations', () => {
  const mutationOperations = [
    'publish',
    'overwrite',
    'unpublish',
    'change-visibility',
    'change-allowlist',
    'change-password',
  ] satisfies readonly AclOperation['kind'][]

  test.each(mutationOperations)('owner may %s', (kind) => {
    expect(
      decideAcl(viewers.owner, pageBase, collection, {
        ...config,
        operation: { kind },
      }),
    ).toEqual({ allowed: true, resolvedVisibility: 'default' })
  })

  test('admin may unpublish but may not publish or edit another collection', () => {
    expect(
      decideAcl(viewers.admin, pageBase, collection, {
        ...config,
        operation: { kind: 'unpublish' },
      }),
    ).toEqual({ allowed: true, resolvedVisibility: 'default' })

    for (const kind of mutationOperations.filter((operation) => operation !== 'unpublish')) {
      expect(
        decideAcl(viewers.admin, pageBase, collection, {
          ...config,
          operation: { kind },
        }),
      ).toEqual({
        allowed: false,
        reason: 'owner-required',
        resolvedVisibility: 'default',
      })
    }
  })

  test('non-owners and anonymous viewers cannot mutate', () => {
    expect(
      decideAcl(viewers.domainUser, pageBase, collection, {
        ...config,
        operation: { kind: 'publish' },
      }),
    ).toEqual({
      allowed: false,
      reason: 'owner-required',
      resolvedVisibility: 'default',
    })

    expect(
      decideAcl(viewers.anonymous, pageBase, collection, {
        ...config,
        operation: { kind: 'unpublish' },
      }),
    ).toEqual({
      allowed: false,
      reason: 'authentication-required',
      resolvedVisibility: 'default',
    })
  })
})
