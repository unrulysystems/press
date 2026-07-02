import { describe, expect, test } from 'bun:test'

import { ConfigError, parseConfig } from './index'

const validEnv = {
  NODE_ENV: 'development',
  PRESS_BASE_URL: 'http://127.0.0.1:4173',
  PRESS_ALLOWED_DOMAINS: 'send.it, example.com',
  PRESS_ADMIN_EMAILS: 'admin@send.it',
  DATABASE_URL: 'postgres://press:press@127.0.0.1:54329/press',
  PRESS_STORAGE_DIR: '.press/localnet/storage',
  BETTER_AUTH_SECRET: 'localnet-secret-at-least-32-bytes',
  PRESS_ENABLE_CREDENTIAL_AUTH: '1',
}

function expectConfigError(env: Record<string, string | undefined>, name: string): void {
  expect(() => parseConfig(env)).toThrow(ConfigError)
  expect(() => parseConfig(env)).toThrow(name)
}

describe('parseConfig', () => {
  test('returns typed config with normalized csv and default upload limit', () => {
    const config = parseConfig(validEnv)

    expect(config).toEqual({
      nodeEnv: 'development',
      baseUrl: 'http://127.0.0.1:4173',
      allowedDomains: ['send.it', 'example.com'],
      adminEmails: ['admin@send.it'],
      databaseUrl: 'postgres://press:press@127.0.0.1:54329/press',
      storageDir: '.press/localnet/storage',
      betterAuthSecret: 'localnet-secret-at-least-32-bytes',
      credentialAuthEnabled: true,
      maxUploadBytes: 26_214_400,
    })
  })

  test('requires core boot variables', () => {
    for (const variable of [
      'PRESS_BASE_URL',
      'DATABASE_URL',
      'PRESS_STORAGE_DIR',
      'BETTER_AUTH_SECRET',
    ] as const) {
      expectConfigError({ ...validEnv, [variable]: undefined }, variable)
    }
  })

  test('rejects malformed values with the offending variable name', () => {
    expectConfigError({ ...validEnv, PRESS_BASE_URL: 'not-a-url' }, 'PRESS_BASE_URL')
    expectConfigError({ ...validEnv, DATABASE_URL: 'http://127.0.0.1/db' }, 'DATABASE_URL')
    expectConfigError(
      { ...validEnv, PRESS_ALLOWED_DOMAINS: 'send.it, @bad' },
      'PRESS_ALLOWED_DOMAINS',
    )
    expectConfigError({ ...validEnv, PRESS_ADMIN_EMAILS: 'admin-at-send.it' }, 'PRESS_ADMIN_EMAILS')
    expectConfigError(
      { ...validEnv, PRESS_ENABLE_CREDENTIAL_AUTH: 'true' },
      'PRESS_ENABLE_CREDENTIAL_AUTH',
    )
    expectConfigError({ ...validEnv, PRESS_MAX_UPLOAD_BYTES: '0' }, 'PRESS_MAX_UPLOAD_BYTES')
  })

  test('requires production-only config in production', () => {
    const prodBase = {
      ...validEnv,
      NODE_ENV: 'production',
      PRESS_ENABLE_CREDENTIAL_AUTH: undefined,
    }

    expectConfigError({ ...prodBase, PRESS_ALLOWED_DOMAINS: '' }, 'PRESS_ALLOWED_DOMAINS')
    expectConfigError({ ...prodBase, GOOGLE_CLIENT_ID: undefined }, 'GOOGLE_CLIENT_ID')
    expectConfigError({ ...prodBase, GOOGLE_CLIENT_ID: 'google-client-id' }, 'GOOGLE_CLIENT_SECRET')

    expect(
      parseConfig({
        ...prodBase,
        GOOGLE_CLIENT_ID: 'google-client-id',
        GOOGLE_CLIENT_SECRET: 'google-client-secret',
      }).googleClientId,
    ).toBe('google-client-id')
  })

  test('refuses credential auth in production', () => {
    expectConfigError(
      {
        ...validEnv,
        NODE_ENV: 'production',
        GOOGLE_CLIENT_ID: 'google-client-id',
        GOOGLE_CLIENT_SECRET: 'google-client-secret',
        PRESS_ENABLE_CREDENTIAL_AUTH: '1',
      },
      'PRESS_ENABLE_CREDENTIAL_AUTH',
    )
  })
})
