import { describe, expect, test } from 'bun:test'

import { isUserActivelyBanned, mintApiTokenForUser, verifyApiToken } from './apiTokens'

type PressDb = Parameters<typeof mintApiTokenForUser>[0]

type FakeUser = {
  readonly id: string
  readonly email: string
  readonly role: 'user' | 'admin'
  banned: boolean
  banExpires: Date | null
}

type InsertedToken = {
  readonly id: string
  readonly userId: string
  readonly name: string
  readonly tokenHash: string
  revokedAt: Date | null
  lastUsedAt: Date | null
}

function createFakeTokenDb(user: FakeUser): {
  readonly db: PressDb
  readonly updates: readonly { readonly lastUsedAt?: Date }[]
} {
  let insertedToken: InsertedToken | undefined
  const updates: { readonly lastUsedAt?: Date }[] = []
  const fake = {
    insert() {
      return {
        async values(values: Omit<InsertedToken, 'revokedAt' | 'lastUsedAt'>) {
          insertedToken = { ...values, revokedAt: null, lastUsedAt: null }
        },
      }
    },
    select() {
      return {
        from() {
          return {
            innerJoin() {
              return {
                where() {
                  return {
                    async limit() {
                      if (!insertedToken) {
                        return []
                      }
                      return [
                        {
                          tokenId: insertedToken.id,
                          revokedAt: insertedToken.revokedAt,
                          userId: user.id,
                          email: user.email,
                          role: user.role,
                          banned: user.banned,
                          banExpires: user.banExpires,
                        },
                      ]
                    },
                  }
                },
              }
            },
          }
        },
      }
    },
    update() {
      return {
        set(values: { readonly lastUsedAt?: Date }) {
          return {
            async where() {
              updates.push(values)
              if (insertedToken && values.lastUsedAt) {
                insertedToken.lastUsedAt = values.lastUsedAt
              }
            },
          }
        },
      }
    },
  }
  return { db: fake as unknown as PressDb, updates }
}

function bearer(token: string): Headers {
  return new Headers({ authorization: `Bearer ${token}` })
}

describe('verifyApiToken ban handling', () => {
  test('rejects active bans without updating lastUsedAt', async () => {
    const user: FakeUser = {
      id: 'user-banned',
      email: 'banned@send.it',
      role: 'user',
      banned: true,
      banExpires: null,
    }
    const fake = createFakeTokenDb(user)
    const token = await mintApiTokenForUser(fake.db, { userId: user.id, name: 'test-token' })

    await expect(verifyApiToken(fake.db, bearer(token))).resolves.toBeNull()
    expect(fake.updates).toHaveLength(0)
  })

  test('accepts expired bans and records successful use', async () => {
    const user: FakeUser = {
      id: 'user-expired-ban',
      email: 'expired@send.it',
      role: 'user',
      banned: true,
      banExpires: new Date(Date.now() - 1_000),
    }
    const fake = createFakeTokenDb(user)
    const token = await mintApiTokenForUser(fake.db, { userId: user.id, name: 'test-token' })

    await expect(verifyApiToken(fake.db, bearer(token))).resolves.toEqual({
      tokenId: expect.any(String),
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    })
    expect(fake.updates).toHaveLength(1)
    expect(fake.updates[0]?.lastUsedAt).toBeInstanceOf(Date)
  })

  test('classifies ban windows explicitly', () => {
    expect(isUserActivelyBanned({ banned: false, banExpires: null })).toBe(false)
    expect(isUserActivelyBanned({ banned: true, banExpires: null })).toBe(true)
    expect(
      isUserActivelyBanned(
        { banned: true, banExpires: new Date('2026-07-03T12:00:00.000Z') },
        new Date('2026-07-03T11:59:59.000Z'),
      ),
    ).toBe(true)
    expect(
      isUserActivelyBanned(
        { banned: true, banExpires: new Date('2026-07-03T12:00:00.000Z') },
        new Date('2026-07-03T12:00:00.000Z'),
      ),
    ).toBe(false)
  })
})
