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
