import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { eq } from 'drizzle-orm'

import { closeDb, db, dbConfig } from '../db/client'
import { auditEvent, collection, page, user } from '../db/schema'
import { hashPagePassword } from '../publish/passwords'
import { pageBlobPath } from '../publish/storage'
import { auth } from './server'
import { localnetDemoCollections, localnetDemoPages, localnetUsers } from './localnetFixtures'

import type { LocalnetDemoPage } from './localnetFixtures'
import type { InferSelectModel } from 'drizzle-orm'

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

function pageHtml(input: LocalnetDemoPage): string {
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

async function writeDemoBlob(input: LocalnetDemoPage, html: string): Promise<void> {
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

  for (const demoCollection of localnetDemoCollections) {
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

  for (const demoPage of localnetDemoPages) {
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
