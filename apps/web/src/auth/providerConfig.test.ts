import { describe, expect, test } from 'bun:test'

import type { PressConfig } from '@press/core'

import { buildAuthProviderConfig } from './providerConfig'

const baseConfig: PressConfig = {
  nodeEnv: 'development',
  baseUrl: 'http://127.0.0.1:4174',
  allowedDomains: ['send.it'],
  adminEmails: ['admin@send.it'],
  databaseUrl: 'postgres://press:press@127.0.0.1:54329/press',
  storageDir: '.press/localnet/storage',
  betterAuthSecret: 'localnet-secret-at-least-32-bytes',
  credentialAuthEnabled: true,
  maxUploadBytes: 1024 * 1024,
}

describe('auth provider config', () => {
  test('pins Google to identity-only scopes without offline access', () => {
    const google = buildAuthProviderConfig({
      ...baseConfig,
      googleClientId: 'google-client-id',
      googleClientSecret: 'google-client-secret',
    }).socialProviders?.google

    expect(google?.scope).toEqual(['openid', 'email', 'profile'])
    expect(google).toHaveProperty('scope')
    expect(Object.keys(google ?? {})).toContain('scope')
    expect(google).not.toHaveProperty('disableDefaultScope')
    expect(google).not.toHaveProperty('accessType')
    expect(google).not.toHaveProperty('prompt')
  })

  test('omits social providers unless both Google credential values are present', () => {
    expect(buildAuthProviderConfig(baseConfig).socialProviders).toBeUndefined()
    expect(
      buildAuthProviderConfig({
        ...baseConfig,
        googleClientId: 'google-client-id',
      }).socialProviders,
    ).toBeUndefined()
    expect(
      buildAuthProviderConfig({
        ...baseConfig,
        googleClientSecret: 'google-client-secret',
      }).socialProviders,
    ).toBeUndefined()
  })

  test('keeps credential provider settings unchanged', () => {
    expect(buildAuthProviderConfig(baseConfig).emailAndPassword).toEqual({
      enabled: true,
      minPasswordLength: 8,
    })
    expect(
      buildAuthProviderConfig({
        ...baseConfig,
        credentialAuthEnabled: false,
      }).emailAndPassword,
    ).toEqual({
      enabled: false,
      minPasswordLength: 8,
    })
  })
})
