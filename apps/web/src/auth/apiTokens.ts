import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import { apiToken, user } from '../db/schema'

import type { db as dbClient } from '../db/client'

type PressDb = typeof dbClient

export type TokenViewer = {
  readonly id: string
  readonly email: string
  readonly role: 'user' | 'admin'
}

export type VerifiedApiToken = {
  readonly tokenId: string
  readonly user: TokenViewer
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

export async function mintApiTokenForUser(
  db: PressDb,
  input: { readonly userId: string; readonly name: string },
): Promise<string> {
  const plaintext = `press_${randomBytes(32).toString('base64url')}`
  await db.insert(apiToken).values({
    id: randomUUID(),
    userId: input.userId,
    name: input.name,
    tokenHash: hashToken(plaintext),
  })
  return plaintext
}

export function readBearerToken(headers: Headers): string | null {
  const authorization = headers.get('authorization')
  if (!authorization) {
    return null
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization)
  return match?.[1]?.trim() || null
}

export async function verifyApiToken(
  db: PressDb,
  headers: Headers,
): Promise<VerifiedApiToken | null> {
  const plaintext = readBearerToken(headers)
  if (!plaintext) {
    return null
  }

  const row = await db
    .select({
      tokenId: apiToken.id,
      userId: user.id,
      email: user.email,
      role: user.role,
    })
    .from(apiToken)
    .innerJoin(user, eq(apiToken.userId, user.id))
    .where(eq(apiToken.tokenHash, hashToken(plaintext)))
    .limit(1)

  const token = row[0]
  if (!token) {
    return null
  }

  const stored = await db.query.apiToken.findFirst({
    where: eq(apiToken.id, token.tokenId),
  })
  if (!stored || stored.revokedAt !== null) {
    return null
  }

  await db.update(apiToken).set({ lastUsedAt: new Date() }).where(eq(apiToken.id, token.tokenId))

  return {
    tokenId: token.tokenId,
    user: {
      id: token.userId,
      email: token.email,
      role: token.role,
    },
  }
}

export async function findUserIdByEmail(db: PressDb, email: string): Promise<string> {
  const row = await db.query.user.findFirst({
    where: eq(user.email, email),
  })
  if (!row) {
    throw new Error(`seed user not found for ${email}`)
  }
  return row.id
}
