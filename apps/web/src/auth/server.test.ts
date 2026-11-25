import { describe, expect, test } from 'bun:test'
import { betterAuth } from 'better-auth/minimal'

import type { BetterAuthOptions } from 'better-auth'

import type { PressDb } from '../db/client'
import type { WebDbConfig } from '../db/config'

import { buildAuthOptions, stripStoredProviderTokens } from './server'

const requestedDriveScope = 'https://www.googleapis.com/auth/drive.readonly'
const identityScopes = ['openid', 'email', 'profile'] as const

const testConfig: WebDbConfig = {
  nodeEnv: 'development',
  baseUrl: 'http://press.test',
  allowedDomains: ['send.it'],
  adminEmails: ['admin@send.it'],
  databaseUrl: 'postgres://press:press@127.0.0.1:54329/press',
  storageDir: '.press/test/storage',
  betterAuthSecret: 'test-secret-at-least-32-bytes-long',
  credentialAuthEnabled: true,
  maxUploadBytes: 25 * 1024 * 1024,
  maxMetadataBytes: 1024 * 1024,
  google: {
    clientId: 'google-client-id',
    clientSecret: 'google-client-secret',
  },
  authRateLimit: {
    global: { max: 10_000, window: 60 },
    signInEmail: { max: 10_000, window: 60 },
  },
}

const unusedDb = {} as PressDb

async function requestGoogleAuthorizeUrl(): Promise<URL> {
  const productionOptions = buildAuthOptions(testConfig, unusedDb)
  const { database: _database, ...statelessOptions } = productionOptions
  const auth = betterAuth(statelessOptions satisfies BetterAuthOptions)
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

const accountWithTokens = {
  id: 'account-1',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  accountId: 'google-user-123',
  providerId: 'google',
  userId: 'user-1',
  scope: 'openid email profile',
  accessToken: 'ya29.broad-access-token',
  refreshToken: '1//broad-refresh-token',
  idToken: 'header.payload.signature',
  accessTokenExpiresAt: new Date(0),
  refreshTokenExpiresAt: new Date(0),
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

describe('Better Auth provider-token storage policy', () => {
  test('stripStoredProviderTokens nulls all provider tokens, keeps identity metadata', () => {
    const stripped = stripStoredProviderTokens(accountWithTokens)

    expect(stripped.accessToken).toBeNull()
    expect(stripped.refreshToken).toBeNull()
    expect(stripped.idToken).toBeNull()
    expect(stripped.accessTokenExpiresAt).toBeNull()
    expect(stripped.refreshTokenExpiresAt).toBeNull()
    expect(stripped.accountId).toBe('google-user-123')
    expect(stripped.providerId).toBe('google')
    expect(stripped.userId).toBe('user-1')
    expect(stripped.scope).toBe('openid email profile')
  })

  test('account create + update databaseHooks null provider tokens before persistence', async () => {
    const options = buildAuthOptions(testConfig, unusedDb)
    const accountHooks = options.databaseHooks.account

    const results = await Promise.all([
      accountHooks.create.before({ ...accountWithTokens }),
      accountHooks.update.before({ ...accountWithTokens }),
    ])
    for (const result of results) {
      expect(result).not.toBe(false)
      const data = (result as { data: Record<string, unknown> }).data
      expect(data.accessToken).toBeNull()
      expect(data.refreshToken).toBeNull()
      expect(data.idToken).toBeNull()
      expect(data.accessTokenExpiresAt).toBeNull()
      expect(data.refreshTokenExpiresAt).toBeNull()
    }
  })
})
