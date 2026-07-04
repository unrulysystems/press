import { ConfigError, parseConfig } from '@press/core'

import type { PressConfig, PressEnv } from '@press/core'

export class ServerBootError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServerBootError'
  }
}

export function loadServerConfig(env: PressEnv = process.env): PressConfig {
  try {
    const config = parseConfig(env)
    if (config.nodeEnv === 'production' && config.credentialAuthEnabled) {
      throw new ServerBootError(
        'PRESS_ENABLE_CREDENTIAL_AUTH: server boot refused credential auth in production',
      )
    }
    // A running instance with no sign-in provider is a dead-end identity gate (F5):
    // fail closed at boot rather than serve a /login that can never sign anyone in
    // (REQ-CFG-002 / REQ-AUTH-008).
    const googleEnabled = Boolean(config.googleClientId && config.googleClientSecret)
    if (!config.credentialAuthEnabled && !googleEnabled) {
      throw new ServerBootError(
        'auth providers: server boot refused with no sign-in provider enabled — set ' +
          'PRESS_ENABLE_CREDENTIAL_AUTH or configure GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET',
      )
    }
    return config
  } catch (error) {
    if (error instanceof ServerBootError) {
      throw error
    }
    if (error instanceof ConfigError) {
      throw new ServerBootError(`press server boot refused: ${error.message}`)
    }
    throw error
  }
}
