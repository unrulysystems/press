import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import { apiToken, user } from '../db/schema'
import { roleForEmail } from './role'

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

export type MintedApiToken = {
  readonly id: string
  readonly token: string
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

export function isUserActivelyBanned(
  input: { readonly banned: boolean; readonly banExpires: Date | null },
  now = new Date(),
): boolean {
  return input.banned && (input.banExpires === null || input.banExpires.getTime() > now.getTime())
}

export async function mintApiTokenRecordForUser(
  db: PressDb,
  input: { readonly userId: string; readonly name: string },
): Promise<MintedApiToken> {
  const plaintext = `press_${randomBytes(32).toString('base64url')}`
  const id = randomUUID()
  await db.insert(apiToken).values({
    id,
    userId: input.userId,
    name: input.name,
    tokenHash: hashToken(plaintext),
  })
  return { id, token: plaintext }
}

export async function mintApiTokenForUser(
  db: PressDb,
  input: { readonly userId: string; readonly name: string },
): Promise<string> {
  const minted = await mintApiTokenRecordForUser(db, input)
  return minted.token
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
  adminEmails: readonly string[],
): Promise<VerifiedApiToken | null> {
  const plaintext = readBearerToken(headers)
  if (!plaintext) {
    return null
  }

  const row = await db
    .select({
      tokenId: apiToken.id,
      revokedAt: apiToken.revokedAt,
      userId: user.id,
      email: user.email,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(apiToken)
    .innerJoin(user, eq(apiToken.userId, user.id))
    .where(eq(apiToken.tokenHash, hashToken(plaintext)))
    .limit(1)

  const token = row[0]
  if (!token) {
    return null
  }
  if (token.revokedAt !== null) {
    return null
  }
  if (isUserActivelyBanned({ banned: token.banned, banExpires: token.banExpires })) {
    return null
  }

  await db.update(apiToken).set({ lastUsedAt: new Date() }).where(eq(apiToken.id, token.tokenId))

  return {
    tokenId: token.tokenId,
    user: {
      id: token.userId,
      email: token.email,
      // Effective role derives from PRESS_ADMIN_EMAILS at use-time (B-2): the
      // stored role is a cache and must never outlive a config change.
      role: roleForEmail(token.email, adminEmails),
    },
  }
}

export async function revokeApiToken(db: PressDb, tokenId: string): Promise<void> {
  await db.update(apiToken).set({ revokedAt: new Date() }).where(eq(apiToken.id, tokenId))
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
