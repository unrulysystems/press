import { describe, expect, test } from 'bun:test'

import { ServerBootError } from '../server/config'
import { loadDbConfig } from './config'

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

describe('loadDbConfig', () => {
  test('keeps the ratified non-production Better Auth rate-limit defaults', () => {
    expect(loadDbConfig(validEnv).authRateLimit).toEqual({
      global: {
        max: 10_000,
        window: 60,
      },
      signInEmail: {
        max: 10_000,
        window: 60,
      },
    })
  })

  test('keeps the ratified production Better Auth rate-limit defaults', () => {
    expect(
      loadDbConfig({
        ...validEnv,
        NODE_ENV: 'production',
        PRESS_ENABLE_CREDENTIAL_AUTH: '0',
        GOOGLE_CLIENT_ID: 'google-client-id',
        GOOGLE_CLIENT_SECRET: 'google-client-secret',
      }).authRateLimit,
    ).toEqual({
      global: {
        max: 100,
        window: 60,
      },
      signInEmail: {
        max: 5,
        window: 60,
      },
    })
  })

  test('accepts explicit sign-in rate-limit overrides', () => {
    expect(
      loadDbConfig({
        ...validEnv,
        PRESS_RATE_LIMIT_SIGNIN_MAX: '3',
        PRESS_RATE_LIMIT_SIGNIN_WINDOW: '2',
      }).authRateLimit.signInEmail,
    ).toEqual({
      max: 3,
      window: 2,
    })
  })

  test('rejects malformed sign-in rate-limit overrides loudly', () => {
    for (const variable of ['PRESS_RATE_LIMIT_SIGNIN_MAX', 'PRESS_RATE_LIMIT_SIGNIN_WINDOW']) {
      expect(() => loadDbConfig({ ...validEnv, [variable]: '0' })).toThrow(ServerBootError)
      expect(() => loadDbConfig({ ...validEnv, [variable]: '0' })).toThrow(variable)
    }
  })
})
