import type { PressConfig, PressEnv } from '@press/core'

import { ServerBootError, loadServerConfig } from '../server/config'

type RateLimitRuleConfig = {
  readonly max: number
  readonly window: number
}

export type WebDbConfig = PressConfig & {
  readonly authRateLimit: {
    readonly global: RateLimitRuleConfig
    readonly signInEmail: RateLimitRuleConfig
  }
}

const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60
const PRODUCTION_GLOBAL_RATE_LIMIT_MAX = 100
const NON_PRODUCTION_GLOBAL_RATE_LIMIT_MAX = 10_000
const PRODUCTION_SIGNIN_RATE_LIMIT_MAX = 5
const NON_PRODUCTION_SIGNIN_RATE_LIMIT_MAX = 10_000

function parsePositiveInteger(
  env: PressEnv,
  variable: string,
  defaultValue: number,
  noun: string,
): number {
  const raw = env[variable]?.trim()
  if (!raw) {
    return defaultValue
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ServerBootError(`${variable}: must be a positive integer ${noun}`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new ServerBootError(`${variable}: must be a safe integer ${noun}`)
  }
  return value
}

function defaultGlobalRateLimitMax(nodeEnv: string): number {
  return nodeEnv === 'production'
    ? PRODUCTION_GLOBAL_RATE_LIMIT_MAX
    : NON_PRODUCTION_GLOBAL_RATE_LIMIT_MAX
}

function defaultSignInRateLimitMax(nodeEnv: string): number {
  return nodeEnv === 'production'
    ? PRODUCTION_SIGNIN_RATE_LIMIT_MAX
    : NON_PRODUCTION_SIGNIN_RATE_LIMIT_MAX
}

export function loadDbConfig(env: PressEnv = process.env): WebDbConfig {
  const config = loadServerConfig(env)
  return {
    ...config,
    authRateLimit: {
      global: {
        max: defaultGlobalRateLimitMax(config.nodeEnv),
        window: DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
      },
      signInEmail: {
        max: parsePositiveInteger(
          env,
          'PRESS_RATE_LIMIT_SIGNIN_MAX',
          defaultSignInRateLimitMax(config.nodeEnv),
          'request count',
        ),
        window: parsePositiveInteger(
          env,
          'PRESS_RATE_LIMIT_SIGNIN_WINDOW',
          DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
          'second count',
        ),
      },
    },
  }
}
