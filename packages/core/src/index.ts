export const VERSION = '0.0.0'

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export type PressConfig = {
  readonly nodeEnv: string
  readonly baseUrl: string
  readonly allowedDomains: readonly string[]
  readonly adminEmails: readonly string[]
  readonly databaseUrl: string
  readonly storageDir: string
  readonly betterAuthSecret: string
  readonly credentialAuthEnabled: boolean
  readonly maxUploadBytes: number
  readonly googleClientId?: string
  readonly googleClientSecret?: string
}

export type PressEnv = Record<string, string | undefined>

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function fail(variable: string, reason: string): never {
  throw new ConfigError(`${variable}: ${reason}`)
}

function readRequired(env: PressEnv, variable: string): string {
  const value = env[variable]?.trim()
  if (!value) {
    fail(variable, 'required environment variable is missing')
  }
  return value
}

function readOptional(env: PressEnv, variable: string): string | undefined {
  const value = env[variable]?.trim()
  return value ? value : undefined
}

function parseHttpUrl(env: PressEnv, variable: string): string {
  const raw = readRequired(env, variable)
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      fail(variable, 'must use http or https')
    }
    return url.toString().replace(/\/$/, '')
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error
    }
    fail(variable, 'must be a valid URL')
  }
}

function parseDatabaseUrl(env: PressEnv): string {
  const raw = readRequired(env, 'DATABASE_URL')
  try {
    const url = new URL(raw)
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      fail('DATABASE_URL', 'must use postgres or postgresql')
    }
    return raw
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error
    }
    fail('DATABASE_URL', 'must be a valid postgres URL')
  }
}

function parseCsv(env: PressEnv, variable: string): string[] {
  const raw = readOptional(env, variable)
  if (!raw) {
    return []
  }
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function isDomain(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    value,
  )
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function parseAllowedDomains(env: PressEnv, nodeEnv: string): string[] {
  const domains = parseCsv(env, 'PRESS_ALLOWED_DOMAINS')
  const invalid = domains.find((domain) => !isDomain(domain))
  if (invalid) {
    fail('PRESS_ALLOWED_DOMAINS', `invalid domain "${invalid}"`)
  }
  if (nodeEnv === 'production' && domains.length === 0) {
    fail('PRESS_ALLOWED_DOMAINS', 'at least one allowed domain is required in production')
  }
  return domains
}

function parseAdminEmails(env: PressEnv): string[] {
  const emails = parseCsv(env, 'PRESS_ADMIN_EMAILS')
  const invalid = emails.find((email) => !isEmail(email))
  if (invalid) {
    fail('PRESS_ADMIN_EMAILS', `invalid email "${invalid}"`)
  }
  return emails
}

function parseCredentialAuth(env: PressEnv, nodeEnv: string): boolean {
  const raw = readOptional(env, 'PRESS_ENABLE_CREDENTIAL_AUTH')
  if (!raw || raw === '0') {
    return false
  }
  if (raw !== '1') {
    fail('PRESS_ENABLE_CREDENTIAL_AUTH', 'must be "1", "0", or unset')
  }
  if (nodeEnv === 'production') {
    fail('PRESS_ENABLE_CREDENTIAL_AUTH', 'credential auth cannot be enabled in production')
  }
  return true
}

function parseMaxUploadBytes(env: PressEnv): number {
  const raw = readOptional(env, 'PRESS_MAX_UPLOAD_BYTES')
  if (!raw) {
    return DEFAULT_MAX_UPLOAD_BYTES
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    fail('PRESS_MAX_UPLOAD_BYTES', 'must be a positive integer byte count')
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    fail('PRESS_MAX_UPLOAD_BYTES', 'must be a safe integer byte count')
  }
  return value
}

function parseGoogleConfig(
  env: PressEnv,
  nodeEnv: string,
): Pick<PressConfig, 'googleClientId' | 'googleClientSecret'> {
  const googleClientId = readOptional(env, 'GOOGLE_CLIENT_ID')
  const googleClientSecret = readOptional(env, 'GOOGLE_CLIENT_SECRET')

  if (nodeEnv === 'production') {
    if (!googleClientId) {
      fail('GOOGLE_CLIENT_ID', 'required in production')
    }
    if (!googleClientSecret) {
      fail('GOOGLE_CLIENT_SECRET', 'required in production')
    }
  }

  if (googleClientId && !googleClientSecret) {
    fail('GOOGLE_CLIENT_SECRET', 'required when GOOGLE_CLIENT_ID is set')
  }
  if (googleClientSecret && !googleClientId) {
    fail('GOOGLE_CLIENT_ID', 'required when GOOGLE_CLIENT_SECRET is set')
  }

  return {
    ...(googleClientId ? { googleClientId } : {}),
    ...(googleClientSecret ? { googleClientSecret } : {}),
  }
}

export function parseConfig(env: PressEnv): PressConfig {
  const nodeEnv = readOptional(env, 'NODE_ENV') ?? 'development'
  const baseConfig = {
    nodeEnv,
    baseUrl: parseHttpUrl(env, 'PRESS_BASE_URL'),
    allowedDomains: parseAllowedDomains(env, nodeEnv),
    adminEmails: parseAdminEmails(env),
    databaseUrl: parseDatabaseUrl(env),
    storageDir: readRequired(env, 'PRESS_STORAGE_DIR'),
    betterAuthSecret: readRequired(env, 'BETTER_AUTH_SECRET'),
    credentialAuthEnabled: parseCredentialAuth(env, nodeEnv),
    maxUploadBytes: parseMaxUploadBytes(env),
  }

  return {
    ...baseConfig,
    ...parseGoogleConfig(env, nodeEnv),
  }
}
