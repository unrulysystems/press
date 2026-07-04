import { describe, expect, test } from 'bun:test'
import { betterAuth } from 'better-auth/minimal'

import type { BetterAuthOptions } from 'better-auth'

const requestedDriveScope = 'https://www.googleapis.com/auth/drive.readonly'
const identityScopes = ['openid', 'email', 'profile'] as const

async function buildTestAuth() {
  process.env.NODE_ENV = 'development'
  process.env.PRESS_BASE_URL = 'http://press.test'
  process.env.PRESS_ALLOWED_DOMAINS = 'send.it'
  process.env.PRESS_ADMIN_EMAILS = 'admin@send.it'
  process.env.DATABASE_URL = 'postgres://press:press@127.0.0.1:54329/press'
  process.env.PRESS_STORAGE_DIR = '.press/test/storage'
  process.env.BETTER_AUTH_SECRET = 'test-secret-at-least-32-bytes-long'
  process.env.PRESS_ENABLE_CREDENTIAL_AUTH = '1'

  const { stripClientRequestedOAuthScopesHook } = await import('./server')
  return betterAuth({
    baseURL: 'http://press.test/api/auth',
    secret: 'test-secret-at-least-32-bytes-long',
    socialProviders: {
      google: {
        clientId: 'google-client-id',
        clientSecret: 'google-client-secret',
        scope: [...identityScopes],
      },
    },
    hooks: {
      before: stripClientRequestedOAuthScopesHook,
    },
    trustedOrigins: ['http://press.test'],
    logger: {
      level: 'warn',
    },
  } satisfies BetterAuthOptions)
}

async function requestGoogleAuthorizeUrl(): Promise<URL> {
  const auth = await buildTestAuth()
  const response = await auth.handler(
    new Request('http://press.test/api/auth/sign-in/social', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://press.test',
      },
      body: JSON.stringify({
        provider: 'google',
        callbackURL: 'http://press.test/',
        disableRedirect: true,
        scopes: [requestedDriveScope],
      }),
    }),
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as { readonly url?: string }
  if (typeof body.url !== 'string') {
    throw new Error('social sign-in response did not include an authorize URL')
  }
  return new URL(body.url)
}

describe('Better Auth social scope policy', () => {
  test('strips client-requested Google scopes before creating the authorize URL', async () => {
    const authorizeUrl = await requestGoogleAuthorizeUrl()
    const scopes = authorizeUrl.searchParams.get('scope')?.split(' ') ?? []
    const allowed = new Set(identityScopes)

    expect(scopes).toEqual(expect.arrayContaining([...identityScopes]))
    expect(scopes.every((scope) => allowed.has(scope as (typeof identityScopes)[number]))).toBe(
      true,
    )
    expect(scopes).not.toContain(requestedDriveScope)
    expect(authorizeUrl.searchParams.has('access_type')).toBe(false)
    expect(authorizeUrl.searchParams.has('prompt')).toBe(false)
    expect(scopes).not.toContain('offline_access')
  })
})
