import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { parseCollectionSlug, parseFileSlug } from '@press/core'
import { eq } from 'drizzle-orm'

import { closeDb, db, dbConfig } from '../db/client'
import { auditEvent, collection, page, user } from '../db/schema'
import { hashPagePassword } from '../publish/passwords'
import { pageBlobPath } from '../publish/storage'
import { auth } from './server'
import { localnetUsers } from './localnetFixtures'

import type { CollectionSlug, FileSlug, PageVisibility } from '@press/core'
import type { InferSelectModel } from 'drizzle-orm'

type DemoPage = {
  readonly collectionSlug: CollectionSlug
  readonly fileSlug: FileSlug
  readonly title: string
  readonly visibility: PageVisibility | null
  readonly publisherEmail: string
  readonly publishedAt: Date
  readonly allowlist?: readonly string[]
}

const demoCollections = [
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

const demoPages: readonly DemoPage[] = [
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

async function ensureSeedUser(
  seedUser: (typeof localnetUsers)[keyof typeof localnetUsers],
): Promise<void> {
  const existing = await db.query.user.findFirst({
    where: eq(user.email, seedUser.email),
  })
  if (!existing) {
    await auth.api.signUpEmail({
      body: {
        email: seedUser.email,
        password: seedUser.password,
        name: seedUser.name,
      },
      headers: new Headers({
        host: new URL(dbConfig.baseUrl).host,
      }),
    })
  }

  await db
    .update(user)
    .set({
      emailVerified: true,
      role: dbConfig.adminEmails.includes(seedUser.email) ? 'admin' : 'user',
    })
    .where(eq(user.email, seedUser.email))
}

function pageHtml(input: DemoPage): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${input.title}</title></head><body><main><h1>${input.title}</h1><p>Seeded localnet report for press screenshot and index verification.</p></main></body></html>`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function findSeedUser(email: string): Promise<InferSelectModel<typeof user>> {
  const row = await db.query.user.findFirst({
    where: eq(user.email, email),
  })
  if (!row) {
    throw new Error(`seed user missing: ${email}`)
  }
  return row
}

async function writeDemoBlob(input: DemoPage, html: string): Promise<void> {
  const path = pageBlobPath(dbConfig.storageDir, input.collectionSlug, input.fileSlug)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, html)
}

async function ensureDemoContent(): Promise<void> {
  const users = new Map<string, InferSelectModel<typeof user>>()
  for (const seedUser of Object.values(localnetUsers)) {
    // oxlint-disable-next-line no-await-in-loop -- Seed fixtures are small and easier to fail by email.
    users.set(seedUser.email, await findSeedUser(seedUser.email))
  }

  for (const demoCollection of demoCollections) {
    const owner = users.get(demoCollection.ownerEmail)
    if (!owner) {
      throw new Error(`demo collection owner missing: ${demoCollection.ownerEmail}`)
    }
    // oxlint-disable-next-line no-await-in-loop -- Keeps fixture writes deterministic.
    await db
      .insert(collection)
      .values({
        slug: demoCollection.slug,
        title: demoCollection.title,
        ownerId: owner.id,
        defaultVisibility: demoCollection.defaultVisibility,
      })
      .onConflictDoUpdate({
        target: collection.slug,
        set: {
          title: demoCollection.title,
          ownerId: owner.id,
          defaultVisibility: demoCollection.defaultVisibility,
        },
      })
  }

  for (const demoPage of demoPages) {
    const publisher = users.get(demoPage.publisherEmail)
    if (!publisher) {
      throw new Error(`demo page publisher missing: ${demoPage.publisherEmail}`)
    }
    const html = pageHtml(demoPage)
    const passwordHash =
      demoPage.visibility === 'password'
        ? // The plaintext is generated and discarded so seeded password pages behave hash-only.
          // oxlint-disable-next-line no-await-in-loop -- Each password page needs its own hash.
          await hashPagePassword(randomBytes(18).toString('base64url'))
        : null

    // oxlint-disable-next-line no-await-in-loop -- Each page couples one DB row to one blob path.
    await writeDemoBlob(demoPage, html)
    // oxlint-disable-next-line no-await-in-loop -- Deterministic fixture upsert.
    await db
      .insert(page)
      .values({
        id: `demo-${demoPage.collectionSlug}-${demoPage.fileSlug}`,
        collectionSlug: demoPage.collectionSlug,
        fileSlug: demoPage.fileSlug,
        title: demoPage.title,
        visibility: demoPage.visibility,
        passwordHash,
        allowlist: [...(demoPage.allowlist ?? [])],
        contentHash: sha256(html),
        sizeBytes: new TextEncoder().encode(html).byteLength,
        publishedBy: publisher.id,
        publishedAt: demoPage.publishedAt,
        updatedAt: demoPage.publishedAt,
        archivedAt: null,
      })
      .onConflictDoUpdate({
        target: [page.collectionSlug, page.fileSlug],
        set: {
          title: demoPage.title,
          visibility: demoPage.visibility,
          passwordHash,
          allowlist: [...(demoPage.allowlist ?? [])],
          contentHash: sha256(html),
          sizeBytes: new TextEncoder().encode(html).byteLength,
          publishedBy: publisher.id,
          publishedAt: demoPage.publishedAt,
          updatedAt: demoPage.publishedAt,
          archivedAt: null,
        },
      })

    // oxlint-disable-next-line no-await-in-loop -- Audit fixture rows are append-safe by stable id.
    await db
      .insert(auditEvent)
      .values({
        id: `demo-audit-${demoPage.collectionSlug}-${demoPage.fileSlug}`,
        userId: publisher.id,
        action: 'publish',
        collectionSlug: demoPage.collectionSlug,
        fileSlug: demoPage.fileSlug,
        contentHash: sha256(html),
        createdAt: demoPage.publishedAt,
      })
      .onConflictDoNothing()
  }
}

async function main(): Promise<void> {
  if (!dbConfig.credentialAuthEnabled) {
    return
  }

  for (const seedUser of Object.values(localnetUsers)) {
    // oxlint-disable-next-line no-await-in-loop -- Sequential sign-up keeps Better Auth writes deterministic.
    await ensureSeedUser(seedUser)
  }
  await ensureDemoContent()
}

try {
  await main()
} finally {
  await closeDb()
}
