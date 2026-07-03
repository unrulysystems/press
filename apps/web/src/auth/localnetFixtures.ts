import { parseCollectionSlug, parseFileSlug } from '@press/core'

import type { CollectionSlug, FileSlug, PageVisibility } from '@press/core'

export const localnetAllowedDomains = ['send.it'] as const
export const localnetAdminEmails = ['admin@send.it'] as const

export const localnetUsers = {
  owner: {
    email: 'owner@send.it',
    password: 'localnet-owner-password',
    name: 'Owner User',
  },
  secondUser: {
    email: 'second@send.it',
    password: 'localnet-second-password',
    name: 'Second User',
  },
  wrongDomain: {
    email: 'wrong@example.com',
    password: 'localnet-wrong-domain-password',
    name: 'Wrong Domain User',
  },
  external: {
    email: 'external@example.net',
    password: 'localnet-external-password',
    name: 'External User',
  },
  admin: {
    email: 'admin@send.it',
    password: 'localnet-admin-password',
    name: 'Admin User',
  },
} as const

export type LocalnetDemoPage = {
  readonly collectionSlug: CollectionSlug
  readonly fileSlug: FileSlug
  readonly title: string
  readonly visibility: PageVisibility | null
  readonly publisherEmail: string
  readonly publishedAt: Date
  readonly allowlist?: readonly string[]
}

export const localnetDemoCollections = [
  {
    slug: parseCollectionSlug('market-notes'),
    title: 'Market Notes',
    ownerEmail: localnetUsers.owner.email,
    defaultVisibility: 'default' as const,
  },
  {
    slug: parseCollectionSlug('systems-review'),
    title: 'Systems Review',
    ownerEmail: localnetUsers.owner.email,
    defaultVisibility: 'default' as const,
  },
  {
    slug: parseCollectionSlug('field-library'),
    title: 'Field Library',
    ownerEmail: localnetUsers.secondUser.email,
    defaultVisibility: 'public' as const,
  },
  {
    slug: parseCollectionSlug('private-docket'),
    title: 'Private Docket',
    ownerEmail: localnetUsers.owner.email,
    defaultVisibility: 'private' as const,
  },
] as const

export const localnetDemoPages: readonly LocalnetDemoPage[] = [
  {
    collectionSlug: parseCollectionSlug('market-notes'),
    fileSlug: parseFileSlug('agent-margin-review.html'),
    title: 'Agent Margin Review',
    visibility: 'public',
    publisherEmail: localnetUsers.owner.email,
    publishedAt: new Date('2026-07-02T14:00:00.000Z'),
  },
  {
    collectionSlug: parseCollectionSlug('systems-review'),
    fileSlug: parseFileSlug('latency-budget-audit.html'),
    title: 'Latency Budget Audit',
    visibility: 'default',
    publisherEmail: localnetUsers.owner.email,
    publishedAt: new Date('2026-07-01T17:30:00.000Z'),
  },
  {
    collectionSlug: parseCollectionSlug('market-notes'),
    fileSlug: parseFileSlug('checkout-cohort-notes.html'),
    title: 'Checkout Cohort Notes',
    visibility: 'password',
    publisherEmail: localnetUsers.owner.email,
    publishedAt: new Date('2026-06-30T16:00:00.000Z'),
  },
  {
    collectionSlug: parseCollectionSlug('field-library'),
    fileSlug: parseFileSlug('partner-update-brief.html'),
    title: 'Partner Update Brief',
    visibility: null,
    publisherEmail: localnetUsers.secondUser.email,
    publishedAt: new Date('2026-06-28T13:00:00.000Z'),
  },
  {
    collectionSlug: parseCollectionSlug('private-docket'),
    fileSlug: parseFileSlug('board-prep-index.html'),
    title: 'Board Prep Index',
    visibility: 'private',
    publisherEmail: localnetUsers.owner.email,
    publishedAt: new Date('2026-06-27T13:00:00.000Z'),
    allowlist: [localnetUsers.owner.email],
  },
  {
    collectionSlug: parseCollectionSlug('market-notes'),
    fileSlug: parseFileSlug('pricing-scenario-map.html'),
    title: 'Pricing Scenario Map',
    visibility: 'public',
    publisherEmail: localnetUsers.owner.email,
    publishedAt: new Date('2026-06-24T11:00:00.000Z'),
  },
]
