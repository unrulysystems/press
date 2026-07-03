export const VERSION = '0.0.0'

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export const PAGE_VISIBILITIES = ['default', 'public', 'password', 'private'] as const

export type PageVisibility = (typeof PAGE_VISIBILITIES)[number]

export const COLLECTION_DEFAULT_VISIBILITIES = ['default', 'public', 'private'] as const

export type CollectionDefaultVisibility = (typeof COLLECTION_DEFAULT_VISIBILITIES)[number]

export type UserRole = 'user' | 'admin'

export const RESERVED_COLLECTION_SLUGS = [
  'api',
  'p',
  'c',
  'login',
  'logout',
  'cli',
  'assets',
  'admin',
  'docs',
] as const

export type CollectionSlug = string & { readonly __brand: 'CollectionSlug' }
export type FileSlug = string & { readonly __brand: 'FileSlug' }
export type SlugKind = 'collection' | 'file'

export class SlugValidationError extends Error {
  constructor(
    readonly kind: SlugKind,
    message: string,
  ) {
    super(`${kind} slug: ${message}`)
    this.name = 'SlugValidationError'
  }
}

const collectionSlugPattern = /^[a-z0-9][a-z0-9-]{0,62}$/
const fileSlugPattern = /^[a-z0-9][a-z0-9._-]{0,120}\.html$/

export function parseCollectionSlug(value: string): CollectionSlug {
  if (!collectionSlugPattern.test(value)) {
    throw new SlugValidationError('collection', 'must match ^[a-z0-9][a-z0-9-]{0,62}$')
  }
  if ((RESERVED_COLLECTION_SLUGS as readonly string[]).includes(value)) {
    throw new SlugValidationError('collection', `"${value}" is reserved`)
  }
  return value as CollectionSlug
}

export function parseFileSlug(value: string): FileSlug {
  if (!fileSlugPattern.test(value)) {
    throw new SlugValidationError('file', 'must match ^[a-z0-9][a-z0-9._-]{0,120}\\.html$')
  }
  if (value.includes('..')) {
    throw new SlugValidationError('file', 'must not contain ".."')
  }
  return value as FileSlug
}

export type BasicPasswordVerification = {
  readonly verified: boolean
}

export type AuthenticatedViewer = {
  readonly kind: 'authenticated'
  readonly userId: string
  readonly email: string
  readonly role: UserRole
  readonly basicPassword?: BasicPasswordVerification
}

export type AclViewer =
  | { readonly kind: 'anonymous'; readonly basicPassword?: BasicPasswordVerification }
  | AuthenticatedViewer

export type AclOperation =
  | { readonly kind: 'read' }
  | { readonly kind: 'publish' }
  | { readonly kind: 'overwrite' }
  | { readonly kind: 'unpublish' }
  | { readonly kind: 'change-visibility' }
  | { readonly kind: 'change-allowlist' }
  | { readonly kind: 'change-password' }

export type CollectionAcl = {
  readonly slug: string
  readonly ownerId: string
  readonly defaultVisibility?: CollectionDefaultVisibility | null
}

export type PageAcl = {
  readonly collectionSlug: string
  readonly fileSlug: string
  readonly visibility?: PageVisibility | null
  readonly passwordHash?: string | null
  readonly allowlist: readonly string[]
}

export type AclConfig = {
  readonly allowedDomains: readonly string[]
  readonly operation?: AclOperation
}

export type AclDenyReason =
  | 'authentication-required'
  | 'domain-not-allowed'
  | 'email-not-allowlisted'
  | 'password-required'
  | 'password-invalid'
  | 'owner-required'

export type AclDecision =
  | { readonly allowed: true; readonly resolvedVisibility: PageVisibility }
  | {
      readonly allowed: false
      readonly reason: AclDenyReason
      readonly resolvedVisibility: PageVisibility
    }

function allow(resolvedVisibility: PageVisibility): AclDecision {
  return { allowed: true, resolvedVisibility }
}

function deny(reason: AclDenyReason, resolvedVisibility: PageVisibility): AclDecision {
  return { allowed: false, reason, resolvedVisibility }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function emailDomain(email: string): string {
  const domain = normalizeEmail(email).split('@').at(1)
  return domain ?? ''
}

function isAuthenticated(viewer: AclViewer): viewer is AuthenticatedViewer {
  return viewer.kind === 'authenticated'
}

function ownsCollection(viewer: AclViewer, collection: CollectionAcl): boolean {
  return isAuthenticated(viewer) && viewer.userId === collection.ownerId
}

function isAdmin(viewer: AclViewer): boolean {
  return isAuthenticated(viewer) && viewer.role === 'admin'
}

function isOwnerOrAdmin(viewer: AclViewer, collection: CollectionAcl): boolean {
  return ownsCollection(viewer, collection) || isAdmin(viewer)
}

function basicPasswordVerification(viewer: AclViewer): BasicPasswordVerification | null {
  return viewer.basicPassword ?? null
}

function resolveVisibility(page: PageAcl, collection: CollectionAcl): PageVisibility {
  return page.visibility ?? collection.defaultVisibility ?? 'default'
}

function decideReadAcl(
  viewer: AclViewer,
  page: PageAcl,
  collection: CollectionAcl,
  config: AclConfig,
  resolvedVisibility: PageVisibility,
): AclDecision {
  switch (resolvedVisibility) {
    case 'public':
      return allow(resolvedVisibility)
    case 'default': {
      if (!isAuthenticated(viewer)) {
        return deny('authentication-required', resolvedVisibility)
      }
      if (isOwnerOrAdmin(viewer, collection)) {
        return allow(resolvedVisibility)
      }
      const allowedDomains = new Set(config.allowedDomains.map((domain) => domain.toLowerCase()))
      return allowedDomains.has(emailDomain(viewer.email))
        ? allow(resolvedVisibility)
        : deny('domain-not-allowed', resolvedVisibility)
    }
    case 'private': {
      if (!isAuthenticated(viewer)) {
        return deny('authentication-required', resolvedVisibility)
      }
      if (isOwnerOrAdmin(viewer, collection)) {
        return allow(resolvedVisibility)
      }
      const allowlist = new Set(page.allowlist.map(normalizeEmail))
      return allowlist.has(normalizeEmail(viewer.email))
        ? allow(resolvedVisibility)
        : deny('email-not-allowlisted', resolvedVisibility)
    }
    case 'password':
      if (isOwnerOrAdmin(viewer, collection)) {
        return allow(resolvedVisibility)
      }
      const basicPassword = basicPasswordVerification(viewer)
      if (!page.passwordHash) {
        return deny(basicPassword ? 'password-invalid' : 'password-required', resolvedVisibility)
      }
      if (!basicPassword) {
        return deny('password-required', resolvedVisibility)
      }
      return basicPassword.verified
        ? allow(resolvedVisibility)
        : deny('password-invalid', resolvedVisibility)
    default: {
      const exhaustive: never = resolvedVisibility
      throw new Error(`unhandled visibility: ${exhaustive}`)
    }
  }
}

function decideMutationAcl(
  viewer: AclViewer,
  collection: CollectionAcl,
  operation: Exclude<AclOperation, { readonly kind: 'read' }>,
  resolvedVisibility: PageVisibility,
): AclDecision {
  if (!isAuthenticated(viewer)) {
    return deny('authentication-required', resolvedVisibility)
  }
  if (ownsCollection(viewer, collection)) {
    return allow(resolvedVisibility)
  }
  if (operation.kind === 'unpublish' && isAdmin(viewer)) {
    return allow(resolvedVisibility)
  }
  return deny('owner-required', resolvedVisibility)
}

export function decideAcl(
  viewer: AclViewer,
  page: PageAcl,
  collection: CollectionAcl,
  config: AclConfig,
): AclDecision {
  const resolvedVisibility = resolveVisibility(page, collection)
  const operation = config.operation ?? { kind: 'read' }

  if (operation.kind === 'read') {
    return decideReadAcl(viewer, page, collection, config, resolvedVisibility)
  }
  return decideMutationAcl(viewer, collection, operation, resolvedVisibility)
}

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
