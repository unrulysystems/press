import { describe, expect, test } from 'bun:test'

import { buildAuthProviderConfig } from '../auth/providerConfig'
import { ServerBootError, loadServerConfig } from './config'

const validEnv = {
  NODE_ENV: 'development',
  PRESS_BASE_URL: 'http://127.0.0.1:4174',
  PRESS_ALLOWED_DOMAINS: 'send.it',
  PRESS_ADMIN_EMAILS: 'admin@send.it',
  DATABASE_URL: 'postgres://press:press@127.0.0.1:54329/press',
  PRESS_STORAGE_DIR: '.press/localnet/storage',
  BETTER_AUTH_SECRET: 'localnet-secret-at-least-32-bytes',
  PRESS_ENABLE_CREDENTIAL_AUTH: '1',
}

describe('server boot config', () => {
  test('wraps config failures in a loud server boot error', () => {
    expect(() =>
      loadServerConfig({
        ...validEnv,
        NODE_ENV: 'production',
        GOOGLE_CLIENT_ID: 'google-client-id',
        GOOGLE_CLIENT_SECRET: 'google-client-secret',
        PRESS_ENABLE_CREDENTIAL_AUTH: '1',
      }),
    ).toThrow(ServerBootError)
    expect(() =>
      loadServerConfig({
        ...validEnv,
        NODE_ENV: 'production',
        GOOGLE_CLIENT_ID: 'google-client-id',
        GOOGLE_CLIENT_SECRET: 'google-client-secret',
        PRESS_ENABLE_CREDENTIAL_AUTH: '1',
      }),
    ).toThrow('press server boot refused')
  })
})

describe('Better Auth provider gating', () => {
  test('enables credential auth only from PRESS_ENABLE_CREDENTIAL_AUTH', () => {
    expect(buildAuthProviderConfig(loadServerConfig(validEnv)).emailAndPassword).toEqual({
      enabled: true,
      minPasswordLength: 8,
    })
    expect(
      buildAuthProviderConfig(
        loadServerConfig({
          ...validEnv,
          PRESS_ENABLE_CREDENTIAL_AUTH: '0',
        }),
      ).emailAndPassword,
    ).toEqual({
      enabled: false,
      minPasswordLength: 8,
    })
  })

  test('registers Google only when both client values are present', () => {
    expect(buildAuthProviderConfig(loadServerConfig(validEnv)).socialProviders).toBeUndefined()
    expect(
      buildAuthProviderConfig(
        loadServerConfig({
          ...validEnv,
          NODE_ENV: 'production',
          PRESS_ENABLE_CREDENTIAL_AUTH: '0',
          GOOGLE_CLIENT_ID: 'google-client-id',
          GOOGLE_CLIENT_SECRET: 'google-client-secret',
        }),
      ).socialProviders,
    ).toEqual({
      google: {
        clientId: 'google-client-id',
        clientSecret: 'google-client-secret',
        scope: ['openid', 'email', 'profile'],
      },
    })
  })
})
