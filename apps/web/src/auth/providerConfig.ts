import type { PressConfig } from '@press/core'

const googleIdentityScopes = ['openid', 'email', 'profile'] as const

type GoogleProviderConfig = {
  readonly clientId: string
  readonly clientSecret: string
  readonly scope: string[]
}

type AuthProviderConfig = {
  readonly emailAndPassword: {
    readonly enabled: boolean
    readonly minPasswordLength: number
  }
  readonly socialProviders?:
    | {
        readonly google: GoogleProviderConfig
      }
    | undefined
}

function buildGoogleProviderConfig(clientId: string, clientSecret: string): GoogleProviderConfig {
  return {
    clientId,
    clientSecret,
    scope: [...googleIdentityScopes],
  }
}

export function buildAuthProviderConfig(config: PressConfig): AuthProviderConfig {
  return {
    emailAndPassword: {
      enabled: config.credentialAuthEnabled,
      minPasswordLength: 8,
    },
    ...(config.googleClientId && config.googleClientSecret
      ? {
          socialProviders: {
            google: buildGoogleProviderConfig(config.googleClientId, config.googleClientSecret),
          },
        }
      : {}),
  }
}
