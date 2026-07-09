import { createHash, randomBytes } from 'node:crypto'

import { parseCollectionSlug, parseFileSlug } from '@press/core'
import { and, eq, or } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'

import { closeDb, db, dbConfig, pool } from '../db/client'
import { auditEvent, collection, page, pageRedirect, schema, user } from '../db/schema'
import { withPagePathLocks } from '../publish/pagePathLocks'
import { hashPagePassword } from '../publish/passwords'
import { installBlob, removeBlob, removeTempBlob, writeTempBlob } from '../publish/storage'
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

async function seedDemoPage(
  demoPage: LocalnetDemoPage,
  publisher: InferSelectModel<typeof user>,
): Promise<void> {
  const html = pageHtml(demoPage)
  const body = new TextEncoder().encode(html)
  const passwordHash =
    demoPage.visibility === 'password'
      ? // The plaintext is generated and discarded so seeded password pages behave hash-only.
        await hashPagePassword(randomBytes(18).toString('base64url'))
      : null
  const seedId = `demo-${demoPage.collectionSlug}-${demoPage.fileSlug}`
  const existing = await db.query.page.findFirst({
    where: eq(page.id, seedId),
  })
  const lockedPaths = [
    { collectionSlug: demoPage.collectionSlug, fileSlug: demoPage.fileSlug },
    ...(existing &&
    (existing.collectionSlug !== demoPage.collectionSlug || existing.fileSlug !== demoPage.fileSlug)
      ? [
          {
            collectionSlug: parseCollectionSlug(existing.collectionSlug),
            fileSlug: parseFileSlug(existing.fileSlug),
          },
        ]
      : []),
  ]
  const tempPath = await writeTempBlob(
    dbConfig.storageDir,
    demoPage.collectionSlug,
    demoPage.fileSlug,
    body,
  )
  let tempInstalled = false

  try {
    await withPagePathLocks(
      () => pool.connect(),
      lockedPaths,
      async (connection) => {
        const lockedDb = drizzle(connection, { schema })
        let rollbackBlob: (() => Promise<void>) | undefined
        let commitBlob: (() => Promise<void>) | undefined
        let priorPath: { readonly collectionSlug: string; readonly fileSlug: string } | undefined

        try {
          const blob = await installBlob(
            dbConfig.storageDir,
            demoPage.collectionSlug,
            demoPage.fileSlug,
            tempPath,
          )
          tempInstalled = true
          rollbackBlob = blob.rollback
          commitBlob = blob.commit

          await lockedDb.transaction(async (tx) => {
            const txSeedPage = await tx.query.page.findFirst({ where: eq(page.id, seedId) })
            priorPath = txSeedPage
              ? {
                  collectionSlug: txSeedPage.collectionSlug,
                  fileSlug: txSeedPage.fileSlug,
                }
              : undefined
            const canonicalConflict = await tx.query.page.findFirst({
              where: and(
                eq(page.collectionSlug, demoPage.collectionSlug),
                eq(page.fileSlug, demoPage.fileSlug),
              ),
            })
            if (canonicalConflict && canonicalConflict.id !== seedId) {
              // Fixture paths are seed-owned. This preserves the old seed behavior
              // of replacing content at a canonical demo path while restoring the
              // deterministic fixture identity as well.
              await tx.delete(page).where(eq(page.id, canonicalConflict.id))
            }

            await tx
              .delete(pageRedirect)
              .where(
                or(
                  eq(pageRedirect.targetPageId, seedId),
                  and(
                    eq(pageRedirect.sourceCollectionSlug, demoPage.collectionSlug),
                    eq(pageRedirect.sourceFileSlug, demoPage.fileSlug),
                  ),
                ),
              )

            const pageValues = {
              id: seedId,
              collectionSlug: demoPage.collectionSlug,
              fileSlug: demoPage.fileSlug,
              title: demoPage.title,
              visibility: demoPage.visibility,
              passwordHash,
              allowlist: [...(demoPage.allowlist ?? [])],
              contentHash: sha256(html),
              sizeBytes: body.byteLength,
              publishedBy: publisher.id,
              publishedAt: demoPage.publishedAt,
              updatedAt: demoPage.publishedAt,
              archivedAt: null,
            }
            await tx
              .insert(page)
              .values(pageValues)
              .onConflictDoUpdate({
                target: page.id,
                set: {
                  collectionSlug: pageValues.collectionSlug,
                  fileSlug: pageValues.fileSlug,
                  title: pageValues.title,
                  visibility: pageValues.visibility,
                  passwordHash: pageValues.passwordHash,
                  allowlist: pageValues.allowlist,
                  contentHash: pageValues.contentHash,
                  sizeBytes: pageValues.sizeBytes,
                  publishedBy: pageValues.publishedBy,
                  publishedAt: pageValues.publishedAt,
                  updatedAt: pageValues.updatedAt,
                  archivedAt: null,
                },
              })
          })

          rollbackBlob = undefined
          const cleanupBlob = commitBlob
          commitBlob = undefined
          if (cleanupBlob) {
            await cleanupBlob()
          }
          if (
            priorPath &&
            (priorPath.collectionSlug !== demoPage.collectionSlug ||
              priorPath.fileSlug !== demoPage.fileSlug)
          ) {
            await removeBlob(
              dbConfig.storageDir,
              parseCollectionSlug(priorPath.collectionSlug),
              parseFileSlug(priorPath.fileSlug),
            )
          }
        } catch (error) {
          if (rollbackBlob) {
            await rollbackBlob()
          }
          throw error
        }
      },
    )
  } catch (error) {
    if (!tempInstalled) {
      await removeTempBlob(tempPath)
    }
    throw error
  }
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
    // oxlint-disable-next-line no-await-in-loop -- Each page couples one DB row to one blob path.
    await seedDemoPage(demoPage, publisher)

    const html = pageHtml(demoPage)

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
