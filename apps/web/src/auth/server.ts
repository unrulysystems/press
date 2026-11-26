import { eq } from 'drizzle-orm'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { createAuthMiddleware } from 'better-auth/api'
import { betterAuth } from 'better-auth/minimal'

import type { Auth, BetterAuthOptions } from 'better-auth'

import { getDb, getDbConfig } from '../db/client'
import { account, session, user, verification } from '../db/schema'
import { buildAuthProviderConfig } from './providerConfig'
import { roleForEmail } from './role'

import type { PressDb } from '../db/client'
import type { WebDbConfig } from '../db/config'

const socialOAuthPaths = new Set(['/sign-in/social', '/link-social'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stripClientRequestedOAuthScopes(body: unknown): void {
  if (!isRecord(body)) {
    return
  }

  // Better Auth deep-merges hook return contexts, so deleting in place is the
  // faithful way to prevent client scopes from reaching the social endpoint.
  delete body.scopes
  delete body.scope

  if (isRecord(body.idToken)) {
    delete body.idToken.scopes
    delete body.idToken.scope
  }
}

export const stripClientRequestedOAuthScopesHook = createAuthMiddleware(async (ctx) => {
  if (!socialOAuthPaths.has(ctx.path)) {
    return
  }
  stripClientRequestedOAuthScopes(ctx.body)
})

// press uses Google solely to establish identity at sign-in; it never calls Google APIs
// afterward. Null every provider token before persistence so no Google auth material is
// ever stored at rest.
type NulledProviderTokens = {
  accessToken: null
  refreshToken: null
  idToken: null
  accessTokenExpiresAt: null
  refreshTokenExpiresAt: null
}

export function stripStoredProviderTokens<T extends Record<string, unknown>>(
  accountRow: T,
): Omit<T, keyof NulledProviderTokens> & NulledProviderTokens {
  return {
    ...accountRow,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  }
}

export function buildAuthOptions(config: WebDbConfig, database: PressDb) {
  const authProviderConfig = buildAuthProviderConfig(config)
  return {
    baseURL: `${config.baseUrl}/api/auth`,
    secret: config.betterAuthSecret,
    database: drizzleAdapter(database, {
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
    trustedOrigins: [config.baseUrl],
    rateLimit: {
      enabled: true,
      window: config.authRateLimit.global.window,
      max: config.authRateLimit.global.max,
      customRules: {
        '/sign-in/email': {
          window: config.authRateLimit.signInEmail.window,
          max: config.authRateLimit.signInEmail.max,
        },
      },
    },
    session: {
      storeSessionInDatabase: true,
    },
    advanced: {
      useSecureCookies: config.nodeEnv === 'production',
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.nodeEnv === 'production',
      },
    },
    plugins: [],
    hooks: {
      before: stripClientRequestedOAuthScopesHook,
    },
    databaseHooks: {
      user: {
        create: {
          async before(newUser) {
            const email = typeof newUser.email === 'string' ? newUser.email.toLowerCase() : ''
            return {
              data: {
                ...newUser,
                role: roleForEmail(email, config.adminEmails),
              },
            }
          },
        },
      },
      session: {
        create: {
          async before(newSession) {
            // Keep the role cache in sync on sign-in (REQ-AUTH-007); authorization
            // always re-derives the effective role from PRESS_ADMIN_EMAILS.
            const existingUser = await database.query.user.findFirst({
              where: eq(user.id, newSession.userId),
            })
            if (existingUser) {
              await database
                .update(user)
                .set({ role: roleForEmail(existingUser.email, config.adminEmails) })
                .where(eq(user.id, existingUser.id))
            }
          },
        },
      },
      account: {
        create: {
          async before(newAccount) {
            return { data: stripStoredProviderTokens(newAccount) }
          },
        },
        update: {
          async before(newAccount) {
            return { data: stripStoredProviderTokens(newAccount) }
          },
        },
      },
    },
    logger: {
      level: 'warn',
    },
  } satisfies BetterAuthOptions
}

type PressAuth = Auth<ReturnType<typeof buildAuthOptions>>

let cachedAuth: PressAuth | undefined

export function getAuth(): PressAuth {
  cachedAuth ??= betterAuth(buildAuthOptions(getDbConfig(), getDb()))
  return cachedAuth
}
