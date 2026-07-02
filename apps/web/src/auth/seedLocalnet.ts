import { eq } from 'drizzle-orm'

import { closeDb, db, dbConfig } from '../db/client'
import { user } from '../db/schema'
import { auth } from './server'
import { localnetUsers } from './localnetFixtures'

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

async function main(): Promise<void> {
  if (!dbConfig.credentialAuthEnabled) {
    return
  }

  for (const seedUser of Object.values(localnetUsers)) {
    // oxlint-disable-next-line no-await-in-loop -- Sequential sign-up keeps Better Auth writes deterministic.
    await ensureSeedUser(seedUser)
  }
}

try {
  await main()
} finally {
  await closeDb()
}
