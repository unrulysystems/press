import { eq } from 'drizzle-orm'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { createAuthMiddleware } from 'better-auth/api'
import { betterAuth } from 'better-auth/minimal'

import type { Auth, BetterAuthOptions } from 'better-auth'

import { db, dbConfig } from '../db/client'
import { account, session, user, verification } from '../db/schema'
import { buildAuthProviderConfig } from './providerConfig'
import { roleForEmail } from './role'

const authProviderConfig = buildAuthProviderConfig(dbConfig)

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
// afterward. Better Auth would otherwise persist the provider's access/refresh/id tokens in
// the `account` row — and its ID-token sign-in flow (/sign-in/social, /link-social) persists
// CLIENT-supplied `idToken.accessToken`/`refreshToken`, which are not tied to the enforced
// identity-only authorize scopes. Null every provider token before it is stored so no Google
// auth material is ever kept at rest. Identity is already resolved from the validated ID
// token by the time this hook runs, so nulling the stored copies is safe. This uses Better
// Auth's supported account databaseHook (like the user/session hooks below), NOT an adapter
// override or schema change — the columns remain; we simply store null.
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
    window: dbConfig.authRateLimit.global.window,
    max: dbConfig.authRateLimit.global.max,
    customRules: {
      '/sign-in/email': {
        window: dbConfig.authRateLimit.signInEmail.window,
        max: dbConfig.authRateLimit.signInEmail.max,
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
              role: roleForEmail(email, dbConfig.adminEmails),
            },
          }
        },
      },
    },
    session: {
      create: {
        async before(newSession) {
          // Keep the role cache in sync in BOTH directions: promotion and, when
          // an email leaves PRESS_ADMIN_EMAILS, demotion (B-2 / REQ-AUTH-007).
          // Authorization never trusts this cache — it re-derives from config.
          const existingUser = await db.query.user.findFirst({
            where: eq(user.id, newSession.userId),
          })
          if (existingUser) {
            await db
              .update(user)
              .set({ role: roleForEmail(existingUser.email, dbConfig.adminEmails) })
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

export const auth: Auth<typeof authOptions> = betterAuth(authOptions)

export type PressSession = Awaited<ReturnType<typeof auth.api.getSession>>
