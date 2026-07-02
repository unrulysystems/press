import { eq } from 'drizzle-orm'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { betterAuth } from 'better-auth/minimal'
import { admin } from 'better-auth/plugins'

import type { Auth, BetterAuthOptions } from 'better-auth'

import { db, dbConfig } from '../db/client'
import { account, session, user, verification } from '../db/schema'
import { buildAuthProviderConfig } from './providerConfig'

const authProviderConfig = buildAuthProviderConfig(dbConfig)

export const authOptions = {
  baseURL: `${dbConfig.baseUrl}/api/auth`,
  secret: dbConfig.betterAuthSecret,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      account,
      session,
      user,
      verification,
    },
    camelCase: true,
    transaction: true,
  }),
  ...authProviderConfig,
  trustedOrigins: [dbConfig.baseUrl],
  rateLimit: {
    enabled: true,
    window: 60,
    max: dbConfig.nodeEnv === 'production' ? 100 : 10_000,
    customRules: {
      '/sign-in/email': {
        window: 60,
        max: dbConfig.nodeEnv === 'production' ? 5 : 10_000,
      },
    },
  },
  session: {
    storeSessionInDatabase: true,
  },
  advanced: {
    useSecureCookies: dbConfig.nodeEnv === 'production',
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      secure: dbConfig.nodeEnv === 'production',
    },
  },
  plugins: [admin()],
  databaseHooks: {
    user: {
      create: {
        async before(newUser) {
          const email = typeof newUser.email === 'string' ? newUser.email.toLowerCase() : ''
          return {
            data: {
              ...newUser,
              role: dbConfig.adminEmails.includes(email) ? 'admin' : 'user',
            },
          }
        },
      },
    },
    session: {
      create: {
        async before(newSession) {
          const existingUser = await db.query.user.findFirst({
            where: eq(user.id, newSession.userId),
          })
          if (existingUser && dbConfig.adminEmails.includes(existingUser.email.toLowerCase())) {
            await db.update(user).set({ role: 'admin' }).where(eq(user.id, existingUser.id))
          }
        },
      },
    },
  },
  logger: {
    level: 'warn',
  },
} satisfies BetterAuthOptions

export const auth: Auth<typeof authOptions> = betterAuth(authOptions)

export type PressSession = Awaited<ReturnType<typeof auth.api.getSession>>
