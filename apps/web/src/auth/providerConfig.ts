import type { PressConfig } from '@press/core'

type AuthProviderConfig = {
  readonly emailAndPassword: {
    readonly enabled: boolean
    readonly minPasswordLength: number
  }
  readonly socialProviders?:
    | {
        readonly google: {
          readonly clientId: string
          readonly clientSecret: string
        }
      }
    | undefined
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
            google: {
              clientId: config.googleClientId,
              clientSecret: config.googleClientSecret,
            },
          },
        }
      : {}),
  }
}
