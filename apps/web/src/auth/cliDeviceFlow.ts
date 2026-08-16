import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { and, eq } from 'drizzle-orm'

import { db, dbConfig } from '../db/client'
import { user, verification } from '../db/schema'
import { BodyTooLargeError, readCappedBodyText } from '../http/readBody'
import { mintApiTokenForUser } from './apiTokens'
import { consumeRateLimit } from './rateLimit'
import { sweepExpiredCliVerificationRowsBestEffort } from './verificationCleanup'
import { auth } from './server'

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

type CliAuthorizeSession = {
  readonly user: {
    readonly id: string
    readonly email?: string | null
  }
  readonly session?: {
    readonly impersonatedBy?: string | null | undefined
  } | null
}

export type VerificationInsert = {
  readonly id: string
  readonly identifier: string
  readonly value: string
  readonly expiresAt: Date
}

export type CliDeviceGrant = {
  readonly kind: 'cli-device'
  readonly challenge: string
  readonly userId: string | null
  readonly denied: boolean
  readonly lastPollAt: number | null
  readonly intervalSeconds: number
  readonly userCodeIdentifier: string
}

type CliDeviceUserIndex = {
  readonly kind: 'cli-device-user'
  readonly deviceIdentifier: string
}

type CliDeviceConsent = {
  readonly kind: 'cli-device-consent'
  readonly userId: string
}

export const CLI_DEVICE_TTL_MS = 15 * 60 * 1000
export const CLI_DEVICE_INTERVAL_SECONDS = 5
export const CLI_DEVICE_SLOW_DOWN_SECONDS = 5
export const CLI_SMALL_BODY_LIMIT_BYTES = 8 * 1024
export const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const USER_CODE_LENGTH = 8

const START_LIMIT_MAX = 60
const START_LIMIT_WINDOW_MS = 60 * 60 * 1000
const ACTIVATE_LIMIT_MAX = 5
const ACTIVATE_LIMIT_WINDOW_MS = 60 * 1000
const USER_CODE_RETRY_LIMIT = 8

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function errorResponse(error: unknown): Response {
  if (error instanceof BodyTooLargeError) {
    return json({ error: error.message }, error.status)
  }
  if (error instanceof HttpError) {
    return json({ error: error.message }, error.status)
  }
  return json({ error: 'internal server error' }, 500)
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

export function deviceGrantIdentifier(deviceCode: string): string {
  return `cli:device:${hashSecret(deviceCode)}`
}

export function userCodeIdentifier(normalizedUserCode: string): string {
  return `cli:device:user:${hashSecret(normalizedUserCode)}`
}

export function deviceConsentIdentifier(consent: string): string {
  return `cli:device:consent:${hashSecret(consent)}`
}

function startLimitIdentifier(ip: string): string {
  return `cli:device:rl:start:${hashSecret(ip)}`
}

function activateLimitIdentifier(ip: string): string {
  return `cli:device:rl:activate:${hashSecret(ip)}`
}

export function normalizeUserCode(value: string): string {
  return value.replaceAll(/[\s-]/g, '').toUpperCase()
}

export function formatUserCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`
}

export function isNormalizedUserCode(value: string): boolean {
  return (
    value.length === USER_CODE_LENGTH &&
    [...value].every((character) => USER_CODE_ALPHABET.includes(character))
  )
}

export function generateUserCode(bytes: Uint8Array): string {
  if (bytes.length < USER_CODE_LENGTH) {
    throw new Error('user-code entropy too short')
  }
  let code = ''
  for (let index = 0; index < USER_CODE_LENGTH; index += 1) {
    const byte = bytes[index]
    if (byte === undefined) {
      throw new Error('user-code entropy too short')
    }
    const alphabetIndex = byte % USER_CODE_ALPHABET.length
    const character = USER_CODE_ALPHABET[alphabetIndex]
    if (!character) {
      throw new Error('user-code alphabet index out of range')
    }
    code += character
  }
  return code
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const ACTIVATE_PAGE_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  min-height: 100vh; background: #faf9f7; color: #1a1a1a;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  line-height: 1.5; display: flex; justify-content: center;
}
.panel { width: 100%; max-width: 33rem; padding: clamp(1.5rem, 5vw, 4rem); }
.wordmark {
  font-family: Newsreader, Georgia, Cambria, Times New Roman, serif;
  font-size: 1.6rem; font-weight: 600; letter-spacing: -0.01em;
  border-bottom: 1px solid rgba(0,0,0,0.12); padding-bottom: 1rem;
  margin-bottom: clamp(2rem, 8vw, 4rem); display: block;
}
h1 { font-weight: 600; font-size: clamp(1.6rem, 5vw, 2.2rem); line-height: 1.15; margin: 0 0 1rem; }
p { max-width: 34ch; opacity: 0.8; margin: 0 0 1.5rem; }
.meta { font-size: 0.85rem; overflow-wrap: break-word; }
label { display: block; font-weight: 600; margin-bottom: 0.5rem; }
input[name="user_code"] {
  font: inherit; letter-spacing: 0.08em; padding: 0.6rem 0.7rem;
  width: 100%; max-width: 16rem; border: 1px solid rgba(0,0,0,0.2); border-radius: 2px;
  background: transparent; color: inherit;
}
form { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 2rem; }
button {
  padding: 0.7rem 1.4rem; font: inherit; font-weight: 600;
  color: #faf9f7; background: #1a1a1a; border: 0; border-radius: 2px; cursor: pointer;
}
.cancel {
  background: transparent; color: inherit; border: 1px solid rgba(0,0,0,0.2);
}
.error { color: #8a1f1f; }
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #ededed; }
  .wordmark { border-color: rgba(255,255,255,0.14); }
  button { color: #111; background: #ededed; }
  .cancel { border-color: rgba(255,255,255,0.2); }
  input[name="user_code"] { border-color: rgba(255,255,255,0.2); }
  .error { color: #ffb4b4; }
}
`.trim()

export const cliDeviceActivatePageHeaders = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'content-type': 'text/html; charset=utf-8',
} as const

export function renderCliDeviceActivatePage(input: {
  readonly consent: string
  readonly userCode: string
  readonly email: string | null | undefined
  readonly error?: string
}): string {
  const consent = escapeHtml(input.consent)
  const userCode = escapeHtml(input.userCode)
  const email = escapeHtml(input.email ?? '')
  const error = input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve press CLI sign-in</title>
<style>${ACTIVATE_PAGE_STYLE}</style>
</head>
<body>
<main class="panel">
<span class="wordmark">press</span>
<h1>Approve CLI sign-in?</h1>
<p>${email ? `Signed in as <strong>${email}</strong>.` : 'Signed in.'} A press CLI requested a
token that can publish to your collections. Confirm the code matches your terminal, then approve.
Only approve if you started <code>press login --device</code>.</p>
${error}
<form method="post" action="/cli/activate">
<input type="hidden" name="consent" value="${consent}">
<label for="user_code">User code</label>
<input id="user_code" name="user_code" value="${userCode}" autocomplete="one-time-code" spellcheck="false">
<button type="submit" name="action" value="approve">Approve</button>
<button type="submit" name="action" value="deny" class="cancel">Cancel</button>
</form>
</main>
</body>
</html>`
}

export function renderCliDeviceResultPage(input: {
  readonly title: string
  readonly body: string
}): string {
  const title = escapeHtml(input.title)
  const body = escapeHtml(input.body)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${ACTIVATE_PAGE_STYLE}</style>
</head>
<body>
<main class="panel">
<span class="wordmark">press</span>
<h1>${title}</h1>
<p>${body}</p>
</main>
</body>
</html>`
}

function htmlPage(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: { ...cliDeviceActivatePageHeaders },
  })
}

function parseChallenge(value: string | null): string {
  if (!value || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new HttpError(400, 'challenge is required')
  }
  return value
}

function parseDeviceCode(value: string): string {
  if (!value || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new HttpError(400, 'invalid_grant')
  }
  return value
}

function parseConsent(value: string | null): string {
  if (!value || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new HttpError(400, 'consent is required')
  }
  return value
}

function parseActivateAction(value: string | null): 'approve' | 'deny' {
  if (value === 'approve' || value === 'deny') {
    return value
  }
  throw new HttpError(400, 'authorization request is invalid or expired')
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const text = await readCappedBodyText(request, CLI_SMALL_BODY_LIMIT_BYTES)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'request body must be JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'request body must be a JSON object')
  }
  return body as Record<string, unknown>
}

function readString(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${field} is required`)
  }
  return value
}

export function parseDeviceGrant(value: string): CliDeviceGrant {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object') {
    throw new HttpError(400, 'invalid_grant')
  }
  const record = parsed as Partial<CliDeviceGrant>
  if (
    record.kind !== 'cli-device' ||
    typeof record.challenge !== 'string' ||
    (record.userId !== null && typeof record.userId !== 'string') ||
    typeof record.denied !== 'boolean' ||
    (record.lastPollAt !== null && typeof record.lastPollAt !== 'number') ||
    typeof record.intervalSeconds !== 'number' ||
    typeof record.userCodeIdentifier !== 'string'
  ) {
    throw new HttpError(400, 'invalid_grant')
  }
  return {
    kind: 'cli-device',
    challenge: record.challenge,
    userId: record.userId,
    denied: record.denied,
    lastPollAt: record.lastPollAt,
    intervalSeconds: record.intervalSeconds,
    userCodeIdentifier: record.userCodeIdentifier,
  }
}

function parseUserIndex(value: string): CliDeviceUserIndex {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object') {
    throw new HttpError(400, 'authorization request is invalid or expired')
  }
  const record = parsed as Partial<CliDeviceUserIndex>
  if (record.kind !== 'cli-device-user' || typeof record.deviceIdentifier !== 'string') {
    throw new HttpError(400, 'authorization request is invalid or expired')
  }
  return {
    kind: 'cli-device-user',
    deviceIdentifier: record.deviceIdentifier,
  }
}

function parseConsentValue(value: string): CliDeviceConsent {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object') {
    throw new HttpError(400, 'authorization request is invalid or expired')
  }
  const record = parsed as Partial<CliDeviceConsent>
  if (record.kind !== 'cli-device-consent' || typeof record.userId !== 'string') {
    throw new HttpError(400, 'authorization request is invalid or expired')
  }
  return { kind: 'cli-device-consent', userId: record.userId }
}

// Fetch Request has no trusted peer address. X-Forwarded-For is
// client-controlled unless we terminate TLS ourselves, so start rate-limits
// are a single global bucket (bounded grant creation) and activate limits
// by the authenticated user id.
export const DEVICE_START_RATE_LIMIT_KEY = 'global'

export function deviceStartRateLimitKey(_request: Request): string {
  return DEVICE_START_RATE_LIMIT_KEY
}

function rejectImpersonation(session: CliAuthorizeSession): void {
  const impersonatedBy = session.session?.impersonatedBy
  if (impersonatedBy !== null && impersonatedBy !== undefined) {
    throw new HttpError(403, 'cli authorization unavailable while impersonating')
  }
}

function randomDeviceCode(): string {
  return randomBytes(32).toString('base64url')
}

function randomConsentToken(): string {
  return randomBytes(32).toString('base64url')
}

export type CliDeviceStartDependencies = {
  readonly baseUrl: string
  readonly now?: () => number
  readonly randomDeviceCode?: () => string
  readonly randomUserCode?: () => string
  readonly randomId?: () => string
  readonly consumeStartLimit: (key: string) => Promise<boolean>
  readonly insertRow: (row: VerificationInsert) => Promise<void>
  readonly hasIdentifier: (identifier: string) => Promise<boolean>
}

export async function startCliDeviceRequest(
  request: Request,
  dependencies: CliDeviceStartDependencies,
): Promise<Response> {
  try {
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405)
    }
    if (!(await dependencies.consumeStartLimit(deviceStartRateLimitKey(request)))) {
      return json({ error: 'rate limited' }, 429)
    }
    const input = await readJsonObject(request)
    const challenge = parseChallenge(typeof input.challenge === 'string' ? input.challenge : null)
    const now = dependencies.now?.() ?? Date.now()
    const deviceCode = dependencies.randomDeviceCode?.() ?? randomDeviceCode()
    parseDeviceCode(deviceCode)

    let normalizedUserCode = ''
    for (let attempt = 0; attempt < USER_CODE_RETRY_LIMIT; attempt += 1) {
      const candidate =
        dependencies.randomUserCode?.() ?? generateUserCode(randomBytes(USER_CODE_LENGTH))
      const normalized = normalizeUserCode(candidate)
      if (!isNormalizedUserCode(normalized)) {
        throw new HttpError(500, 'internal server error')
      }
      // oxlint-disable-next-line no-await-in-loop -- Collision check is sequential; a later code must not reuse an earlier attempt.
      if (!(await dependencies.hasIdentifier(userCodeIdentifier(normalized)))) {
        normalizedUserCode = normalized
        break
      }
    }
    if (!normalizedUserCode) {
      throw new HttpError(500, 'internal server error')
    }

    const userIdentifier = userCodeIdentifier(normalizedUserCode)
    const deviceIdentifier = deviceGrantIdentifier(deviceCode)
    const expiresAt = new Date(now + CLI_DEVICE_TTL_MS)
    const newId = () => dependencies.randomId?.() ?? randomUUID()
    const grant: CliDeviceGrant = {
      kind: 'cli-device',
      challenge,
      userId: null,
      denied: false,
      lastPollAt: null,
      intervalSeconds: CLI_DEVICE_INTERVAL_SECONDS,
      userCodeIdentifier: userIdentifier,
    }
    await dependencies.insertRow({
      id: newId(),
      identifier: deviceIdentifier,
      value: JSON.stringify(grant),
      expiresAt,
    })
    const userIndex: CliDeviceUserIndex = {
      kind: 'cli-device-user',
      deviceIdentifier,
    }
    await dependencies.insertRow({
      id: newId(),
      identifier: userIdentifier,
      value: JSON.stringify(userIndex),
      expiresAt,
    })

    const verificationUri = `${dependencies.baseUrl}/cli/activate`
    const formatted = formatUserCode(normalizedUserCode)
    return json({
      device_code: deviceCode,
      user_code: formatted,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(formatted)}`,
      expires_in: CLI_DEVICE_TTL_MS / 1000,
      interval: CLI_DEVICE_INTERVAL_SECONDS,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export type CliDevicePollDependencies = {
  readonly now?: () => number
  readonly loadRow: (identifier: string) => Promise<VerificationInsert | undefined>
  readonly compareAndSaveRow: (input: {
    readonly expectedValue: string
    readonly next: VerificationInsert
  }) => Promise<boolean>
  readonly consumeRow: (identifier: string) => Promise<VerificationInsert | undefined>
  readonly mintToken: (userId: string) => Promise<{
    readonly token: string
    readonly user: { readonly id: string; readonly email: string; readonly role: string }
  }>
}

async function mintFromConsumedGrant(
  identifier: string,
  verifier: string,
  dependencies: CliDevicePollDependencies,
): Promise<Response> {
  const consumed = await dependencies.consumeRow(identifier)
  if (!consumed) {
    throw new HttpError(400, 'invalid_grant')
  }
  const consumedGrant = parseDeviceGrant(consumed.value)
  if (consumedGrant.denied) {
    throw new HttpError(400, 'access_denied')
  }
  if (!consumedGrant.userId || consumedGrant.challenge !== hashSecret(verifier)) {
    throw new HttpError(400, 'invalid_grant')
  }
  await dependencies.consumeRow(consumedGrant.userCodeIdentifier)
  const minted = await dependencies.mintToken(consumedGrant.userId)
  return json({
    token: minted.token,
    user: minted.user,
  })
}

async function continueAfterLostPollCas(
  identifier: string,
  verifier: string,
  now: number,
  dependencies: CliDevicePollDependencies,
): Promise<Response> {
  const fresh = await dependencies.loadRow(identifier)
  if (!fresh) {
    throw new HttpError(400, 'invalid_grant')
  }
  if (fresh.expiresAt.getTime() < now) {
    throw new HttpError(400, 'expired_token')
  }
  const grant = parseDeviceGrant(fresh.value)
  if (grant.denied) {
    throw new HttpError(400, 'access_denied')
  }
  if (!grant.userId) {
    throw new HttpError(400, 'authorization_pending')
  }
  if (grant.challenge !== hashSecret(verifier)) {
    throw new HttpError(400, 'invalid_grant')
  }
  return await mintFromConsumedGrant(identifier, verifier, dependencies)
}

export async function pollCliDeviceRequest(
  request: Request,
  dependencies: CliDevicePollDependencies,
): Promise<Response> {
  try {
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405)
    }
    const input = await readJsonObject(request)
    const deviceCode = parseDeviceCode(readString(input, 'device_code'))
    const verifier = readString(input, 'verifier')
    const now = dependencies.now?.() ?? Date.now()
    const identifier = deviceGrantIdentifier(deviceCode)
    const row = await dependencies.loadRow(identifier)
    if (!row) {
      throw new HttpError(400, 'invalid_grant')
    }
    if (row.expiresAt.getTime() < now) {
      throw new HttpError(400, 'expired_token')
    }
    const grant = parseDeviceGrant(row.value)
    if (grant.denied) {
      throw new HttpError(400, 'access_denied')
    }
    if (grant.lastPollAt !== null && now < grant.lastPollAt + grant.intervalSeconds * 1000) {
      const slowed: CliDeviceGrant = {
        ...grant,
        intervalSeconds: grant.intervalSeconds + CLI_DEVICE_SLOW_DOWN_SECONDS,
      }
      const saved = await dependencies.compareAndSaveRow({
        expectedValue: row.value,
        next: { ...row, value: JSON.stringify(slowed) },
      })
      if (!saved) {
        return await continueAfterLostPollCas(identifier, verifier, now, dependencies)
      }
      throw new HttpError(400, 'slow_down')
    }

    if (!grant.userId) {
      const pending: CliDeviceGrant = { ...grant, lastPollAt: now }
      const saved = await dependencies.compareAndSaveRow({
        expectedValue: row.value,
        next: { ...row, value: JSON.stringify(pending) },
      })
      if (!saved) {
        return await continueAfterLostPollCas(identifier, verifier, now, dependencies)
      }
      throw new HttpError(400, 'authorization_pending')
    }

    if (grant.challenge !== hashSecret(verifier)) {
      throw new HttpError(400, 'invalid_grant')
    }

    return await mintFromConsumedGrant(identifier, verifier, dependencies)
  } catch (error) {
    return errorResponse(error)
  }
}

export type CliDeviceActivateDependencies = {
  readonly baseUrl: string
  readonly getSession: (headers: Headers) => Promise<CliAuthorizeSession | null>
  readonly now?: () => number
  readonly randomConsent?: () => string
  readonly randomId?: () => string
  readonly consumeActivateLimit: (userId: string) => Promise<boolean>
  readonly insertRow: (row: VerificationInsert) => Promise<void>
  readonly consumeRow: (identifier: string) => Promise<VerificationInsert | undefined>
  readonly loadRow: (identifier: string) => Promise<VerificationInsert | undefined>
  readonly saveRow: (row: VerificationInsert) => Promise<void>
}

async function issueActivatePage(
  dependencies: CliDeviceActivateDependencies,
  session: CliAuthorizeSession,
  userCode: string,
  error?: string,
): Promise<Response> {
  const consent = dependencies.randomConsent?.() ?? randomConsentToken()
  const now = dependencies.now?.() ?? Date.now()
  const consentValue: CliDeviceConsent = {
    kind: 'cli-device-consent',
    userId: session.user.id,
  }
  await dependencies.insertRow({
    id: dependencies.randomId?.() ?? randomUUID(),
    identifier: deviceConsentIdentifier(consent),
    value: JSON.stringify(consentValue),
    expiresAt: new Date(now + CLI_DEVICE_TTL_MS),
  })
  return htmlPage(
    renderCliDeviceActivatePage({
      consent,
      userCode,
      email: session.user.email,
      ...(error ? { error } : {}),
    }),
  )
}

async function readActivateForm(request: Request): Promise<{
  readonly consent: string
  readonly userCode: string
  readonly action: 'approve' | 'deny'
}> {
  const text = await readCappedBodyText(request, CLI_SMALL_BODY_LIMIT_BYTES)
  const params = new URLSearchParams(text)
  return {
    consent: parseConsent(params.get('consent')),
    userCode: params.get('user_code') ?? '',
    action: parseActivateAction(params.get('action')),
  }
}

export async function activateCliDeviceRequest(
  request: Request,
  dependencies: CliDeviceActivateDependencies,
): Promise<Response> {
  try {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405)
    }
    const session = await dependencies.getSession(request.headers)
    if (!session) {
      if (request.method === 'GET') {
        const nextUrl = new URL(request.url)
        const next = nextUrl.pathname + nextUrl.search
        return Response.redirect(
          `${dependencies.baseUrl}/login?next=${encodeURIComponent(next)}`,
          302,
        )
      }
      return json({ error: 'authentication required' }, 401)
    }
    rejectImpersonation(session)

    if (request.method === 'GET') {
      const url = new URL(request.url)
      const prefilled = url.searchParams.get('user_code') ?? ''
      // F-32: the GET renders a fresh consent row, so it shares the activate
      // budget with the POST — an authenticated user must not be able to grow
      // the verification table without bound by re-rendering the page.
      if (!(await dependencies.consumeActivateLimit(session.user.id))) {
        throw new HttpError(429, 'rate limited')
      }
      return await issueActivatePage(dependencies, session, prefilled)
    }

    if (!(await dependencies.consumeActivateLimit(session.user.id))) {
      throw new HttpError(429, 'rate limited')
    }
    const form = await readActivateForm(request)
    const now = dependencies.now?.() ?? Date.now()
    const consentRow = await dependencies.consumeRow(deviceConsentIdentifier(form.consent))
    if (!consentRow || consentRow.expiresAt.getTime() < now) {
      return await issueActivatePage(
        dependencies,
        session,
        form.userCode,
        'authorization request is invalid or expired',
      )
    }
    const consent = parseConsentValue(consentRow.value)
    if (consent.userId !== session.user.id) {
      throw new HttpError(403, 'approval must come from the session that started the request')
    }

    const normalized = normalizeUserCode(form.userCode)
    const genericError = 'authorization request is invalid or expired'
    if (!isNormalizedUserCode(normalized)) {
      return await issueActivatePage(dependencies, session, form.userCode, genericError)
    }
    const indexRow = await dependencies.loadRow(userCodeIdentifier(normalized))
    if (!indexRow || indexRow.expiresAt.getTime() < now) {
      return await issueActivatePage(dependencies, session, form.userCode, genericError)
    }
    const index = parseUserIndex(indexRow.value)
    const grantRow = await dependencies.loadRow(index.deviceIdentifier)
    if (!grantRow || grantRow.expiresAt.getTime() < now) {
      return await issueActivatePage(dependencies, session, form.userCode, genericError)
    }
    const grant = parseDeviceGrant(grantRow.value)
    if (grant.denied) {
      return await issueActivatePage(dependencies, session, form.userCode, genericError)
    }
    if (grant.userId && grant.userId !== session.user.id) {
      return await issueActivatePage(dependencies, session, form.userCode, genericError)
    }

    const nextGrant: CliDeviceGrant =
      form.action === 'deny'
        ? { ...grant, denied: true, userId: null }
        : { ...grant, userId: session.user.id, denied: false }
    await dependencies.saveRow({
      ...grantRow,
      value: JSON.stringify(nextGrant),
    })

    if (form.action === 'deny') {
      return htmlPage(
        renderCliDeviceResultPage({
          title: 'CLI sign-in cancelled',
          body: 'Return to the CLI. No token was issued.',
        }),
      )
    }
    return htmlPage(
      renderCliDeviceResultPage({
        title: 'CLI sign-in approved',
        body: 'Return to the CLI. It will finish signing in on its own.',
      }),
    )
  } catch (error) {
    return errorResponse(error)
  }
}

async function insertVerificationRow(row: VerificationInsert): Promise<void> {
  await db.insert(verification).values(row)
}

async function loadVerificationRow(identifier: string): Promise<VerificationInsert | undefined> {
  const row = await db.query.verification.findFirst({
    where: eq(verification.identifier, identifier),
  })
  if (!row) {
    return undefined
  }
  return {
    id: row.id,
    identifier: row.identifier,
    value: row.value,
    expiresAt: row.expiresAt,
  }
}

async function saveVerificationRow(row: VerificationInsert): Promise<void> {
  await db
    .update(verification)
    .set({ value: row.value, updatedAt: new Date() })
    .where(eq(verification.identifier, row.identifier))
}

async function compareAndSaveVerificationRow(input: {
  readonly expectedValue: string
  readonly next: VerificationInsert
}): Promise<boolean> {
  const updated = await db
    .update(verification)
    .set({ value: input.next.value, updatedAt: new Date() })
    .where(
      and(
        eq(verification.identifier, input.next.identifier),
        eq(verification.value, input.expectedValue),
      ),
    )
    .returning({ id: verification.id })
  return updated.length > 0
}

async function consumeVerificationRow(identifier: string): Promise<VerificationInsert | undefined> {
  const rows = await db
    .delete(verification)
    .where(eq(verification.identifier, identifier))
    .returning()
  const row = rows[0]
  if (!row) {
    return undefined
  }
  return {
    id: row.id,
    identifier: row.identifier,
    value: row.value,
    expiresAt: row.expiresAt,
  }
}

async function hasVerificationIdentifier(identifier: string): Promise<boolean> {
  const row = await db.query.verification.findFirst({
    where: eq(verification.identifier, identifier),
  })
  return Boolean(row)
}

export async function cliDeviceStartEndpoint(request: Request): Promise<Response> {
  // F-33: sweep stale cli:* rows before creating new device-flow rows.
  await sweepExpiredCliVerificationRowsBestEffort(db)
  return await startCliDeviceRequest(request, {
    baseUrl: dbConfig.baseUrl,
    consumeStartLimit: async (key) =>
      consumeRateLimit(db, {
        identifier: startLimitIdentifier(key),
        max: START_LIMIT_MAX,
        windowMs: START_LIMIT_WINDOW_MS,
        now: Date.now(),
      }),
    insertRow: insertVerificationRow,
    hasIdentifier: hasVerificationIdentifier,
  })
}

export async function cliDevicePollEndpoint(request: Request): Promise<Response> {
  return await pollCliDeviceRequest(request, {
    loadRow: loadVerificationRow,
    compareAndSaveRow: compareAndSaveVerificationRow,
    consumeRow: consumeVerificationRow,
    mintToken: async (userId) => {
      const token = await mintApiTokenForUser(db, {
        userId,
        name: `press cli ${new Date().toISOString()}`,
      })
      const sessionUser = await db.query.user.findFirst({
        where: eq(user.id, userId),
      })
      if (!sessionUser) {
        throw new HttpError(400, 'authorization user not found')
      }
      return {
        token,
        user: {
          id: sessionUser.id,
          email: sessionUser.email,
          role: sessionUser.role,
        },
      }
    },
  })
}

export async function cliDeviceActivateEndpoint(request: Request): Promise<Response> {
  // F-33: sweep stale cli:* rows before the GET/POST can create a new consent row.
  await sweepExpiredCliVerificationRowsBestEffort(db)
  return await activateCliDeviceRequest(request, {
    baseUrl: dbConfig.baseUrl,
    getSession: async (headers) =>
      (await auth.api.getSession({ headers })) as CliAuthorizeSession | null,
    consumeActivateLimit: async (userId) =>
      consumeRateLimit(db, {
        identifier: activateLimitIdentifier(userId),
        max: ACTIVATE_LIMIT_MAX,
        windowMs: ACTIVATE_LIMIT_WINDOW_MS,
        now: Date.now(),
      }),
    insertRow: insertVerificationRow,
    consumeRow: consumeVerificationRow,
    loadRow: loadVerificationRow,
    saveRow: saveVerificationRow,
  })
}
