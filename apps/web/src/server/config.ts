import { ConfigError, parseConfig } from '@press/core'

import type { PressConfig, PressEnv } from '@press/core'

export class ServerBootError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ServerBootError'
  }
}

export function loadServerConfig(env: PressEnv = process.env): PressConfig {
  try {
    const config = parseConfig(env)
    // Fail closed at boot if no sign-in provider is enabled (REQ-CFG-002 / REQ-AUTH-008).
    if (!config.credentialAuthEnabled && !config.google) {
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
      throw new ServerBootError(`press server boot refused: ${error.message}`, { cause: error })
    }
    throw error
  }
}
