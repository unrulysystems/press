import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import { getDb, getDbConfig } from '../db/client'
import { apiToken, auditEvent, user, verification } from '../db/schema'
import { readCappedBodyText } from '../http/readBody'
import {
  HttpError,
  escapeHtml,
  jsonErrorResponse,
  jsonResponse,
  readBoundedJsonObject,
} from '../http/responses'
import { isUserActivelyBanned, mintApiTokenForUser, verifyApiToken } from './apiTokens'
import { roleForEmail } from './role'
import { getAuth } from './server'
import { sweepExpiredCliVerificationRowsBestEffort } from './verificationCleanup'

type CliVerificationValue = {
  readonly kind: 'cli-loopback'
  readonly userId: string
  readonly challenge: string
}

export type CliAuthorizeSession = {
  readonly user: {
    readonly id: string
    readonly email?: string | null
  }
  readonly session?: {
    readonly impersonatedBy?: string | null | undefined
  } | null
}

type CliPendingValue = {
  readonly kind: 'cli-pending'
  readonly userId: string
  readonly port: number
  readonly challenge: string
  readonly state: string
}

type VerificationInsert = {
  readonly id: string
  readonly identifier: string
  readonly value: string
  readonly expiresAt: Date
}

type CliAuthorizeDependencies = {
  readonly baseUrl: string
  readonly getSession: (headers: Headers) => Promise<CliAuthorizeSession | null>
  readonly insertPending: (row: VerificationInsert) => Promise<void>
  readonly now?: () => number
  readonly randomId?: () => string
  readonly randomConsent?: () => string
}

type CliApproveDependencies = {
  readonly getSession: (headers: Headers) => Promise<CliAuthorizeSession | null>
  readonly consumePending: (state: string) => Promise<CliPendingValue | undefined>
  readonly insertVerification: (row: VerificationInsert) => Promise<void>
  readonly now?: () => number
  readonly randomCode?: () => string
  readonly randomId?: () => string
}

const CLI_SMALL_BODY_LIMIT_BYTES = 8 * 1024
const CLI_PENDING_TTL_MS = 10 * 60 * 1000
const CLI_CODE_TTL_MS = 5 * 60 * 1000

function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

function codeIdentifier(code: string): string {
  return `cli:${hash(code)}`
}

function pendingIdentifier(consent: string): string {
  return `cli:pending:${hash(consent)}`
}

const APPROVAL_PAGE_STYLE = `
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
form { display: flex; gap: 0.75rem; margin-top: 2rem; }
button {
  padding: 0.7rem 1.4rem; font: inherit; font-weight: 600;
  color: #faf9f7; background: #1a1a1a; border: 0; border-radius: 2px; cursor: pointer;
}
.cancel {
  background: transparent; color: inherit; text-decoration: underline;
  display: inline-flex; align-items: center;
}
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #ededed; }
  .wordmark { border-color: rgba(255,255,255,0.14); }
  button { color: #111; background: #ededed; }
}
`.trim()

export function renderCliApprovalPage(input: {
  readonly consent: string
  readonly port: number
  readonly email: string | null | undefined
}): string {
  const consent = escapeHtml(input.consent)
  const port = String(input.port)
  const email = escapeHtml(input.email ?? '')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve press CLI sign-in</title>
<style>${APPROVAL_PAGE_STYLE}</style>
</head>
<body>
<main class="panel">
<span class="wordmark">press</span>
<h1>Approve CLI sign-in?</h1>
<p>${email ? `Signed in as <strong>${email}</strong>.` : 'Signed in.'} A CLI process on
this computer requested a token that can publish to your collections. The token
will be issued only after you approve.</p>
<p class="meta">Loopback port: <code>${port}</code></p>
<form method="post" action="/cli/approve">
<input type="hidden" name="consent" value="${consent}">
<button type="submit">Approve</button>
<a class="cancel" href="/">Cancel</a>
</form>
</main>
</body>
</html>`
}

export const cliApprovalPageHeaders = {
  // form-action must permit loopback so Chromium allows the post-approval redirect.
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:*; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'content-type': 'text/html; charset=utf-8',
} as const

function cliApprovalPageResponse(input: {
  readonly consent: string
  readonly port: number
  readonly email: string | null | undefined
}): Response {
  return new Response(renderCliApprovalPage(input), {
    status: 200,
    headers: { ...cliApprovalPageHeaders },
  })
}

function parsePort(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new HttpError(400, 'port is required')
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new HttpError(400, 'port must be a valid TCP port')
  }
  return port
}

function parseTokenField(value: string | null, field: string): string {
  if (!value || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new HttpError(400, `${field} is required`)
  }
  return value
}

function parseJsonObjectString(value: string, errorMessage: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new HttpError(400, errorMessage, { cause: error })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, errorMessage)
  }
  return parsed as Record<string, unknown>
}

function parsePendingValue(value: string): CliPendingValue {
  const record = parseJsonObjectString(
    value,
    'authorization request is invalid',
  ) as Partial<CliPendingValue>
  if (
    record.kind !== 'cli-pending' ||
    typeof record.userId !== 'string' ||
    typeof record.port !== 'number' ||
    typeof record.challenge !== 'string' ||
    typeof record.state !== 'string'
  ) {
    throw new HttpError(400, 'authorization request is invalid')
  }
  return {
    kind: 'cli-pending',
    userId: record.userId,
    port: record.port,
    challenge: record.challenge,
    state: record.state,
  }
}

async function readFormConsent(request: Request): Promise<string> {
  const text = await readCappedBodyText(request, CLI_SMALL_BODY_LIMIT_BYTES)
  const params = new URLSearchParams(text)
  return parseTokenField(params.get('consent'), 'consent')
}

function readString(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${field} is required`)
  }
  return value
}

function parseVerificationValue(value: string): CliVerificationValue {
  const record = parseJsonObjectString(
    value,
    'authorization code is invalid',
  ) as Partial<CliVerificationValue>
  if (
    record.kind !== 'cli-loopback' ||
    typeof record.userId !== 'string' ||
    typeof record.challenge !== 'string'
  ) {
    throw new HttpError(400, 'authorization code is invalid')
  }
  return {
    kind: 'cli-loopback',
    userId: record.userId,
    challenge: record.challenge,
  }
}

export async function loadActiveCliSession(headers: Headers): Promise<CliAuthorizeSession | null> {
  const session = (await getAuth().api.getSession({ headers })) as CliAuthorizeSession | null
  if (!session) {
    return null
  }
  const dbUser = await getDb().query.user.findFirst({
    where: eq(user.id, session.user.id),
  })
  if (!dbUser) {
    return null
  }
  if (isUserActivelyBanned({ banned: dbUser.banned, banExpires: dbUser.banExpires })) {
    throw new HttpError(403, 'account is suspended')
  }
  return session
}

export async function authorizeCliRequest(
  request: Request,
  dependencies: CliAuthorizeDependencies,
): Promise<Response> {
  try {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'method not allowed' }, 405)
    }
    const session = await dependencies.getSession(request.headers)
    if (!session) {
      const nextUrl = new URL(request.url)
      const next = nextUrl.pathname + nextUrl.search
      return Response.redirect(
        `${dependencies.baseUrl}/login?next=${encodeURIComponent(next)}`,
        302,
      )
    }
    const impersonatedBy = session.session?.impersonatedBy
    if (impersonatedBy !== null && impersonatedBy !== undefined) {
      throw new HttpError(403, 'cli authorization unavailable while impersonating')
    }

    const url = new URL(request.url)
    const port = parsePort(url.searchParams.get('port'))
    const challenge = parseTokenField(url.searchParams.get('challenge'), 'challenge')
    const state = parseTokenField(url.searchParams.get('state'), 'state')
    const now = dependencies.now?.() ?? Date.now()

    const consent = dependencies.randomConsent?.() ?? randomBytes(32).toString('base64url')
    await dependencies.insertPending({
      id: dependencies.randomId?.() ?? randomUUID(),
      identifier: pendingIdentifier(consent),
      value: JSON.stringify({
        kind: 'cli-pending',
        userId: session.user.id,
        port,
        challenge,
        state,
      } satisfies CliPendingValue),
      expiresAt: new Date(now + CLI_PENDING_TTL_MS),
    })

    return cliApprovalPageResponse({ consent, port, email: session.user.email })
  } catch (error) {
    return jsonErrorResponse('authorizeCliRequest', error, request)
  }
}

export async function approveCliRequest(
  request: Request,
  dependencies: CliApproveDependencies,
): Promise<Response> {
  try {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405)
    }
    const session = await dependencies.getSession(request.headers)
    if (!session) {
      return jsonResponse({ error: 'authentication required' }, 401)
    }
    const impersonatedBy = session.session?.impersonatedBy
    if (impersonatedBy !== null && impersonatedBy !== undefined) {
      throw new HttpError(403, 'cli authorization unavailable while impersonating')
    }

    const consent = await readFormConsent(request)
    const pending = await dependencies.consumePending(consent)
    if (!pending) {
      throw new HttpError(400, 'authorization request is invalid or expired')
    }
    if (pending.userId !== session.user.id) {
      throw new HttpError(403, 'approval must come from the session that started the request')
    }

    const code = dependencies.randomCode?.() ?? randomBytes(32).toString('base64url')
    const now = dependencies.now?.() ?? Date.now()
    await dependencies.insertVerification({
      id: dependencies.randomId?.() ?? randomUUID(),
      identifier: codeIdentifier(code),
      value: JSON.stringify({
        kind: 'cli-loopback',
        userId: pending.userId,
        challenge: pending.challenge,
      } satisfies CliVerificationValue),
      expiresAt: new Date(now + CLI_CODE_TTL_MS),
    })

    const redirectUrl = new URL(`http://127.0.0.1:${pending.port}/callback`)
    redirectUrl.searchParams.set('code', code)
    redirectUrl.searchParams.set('state', pending.state)
    return Response.redirect(redirectUrl.toString(), 302)
  } catch (error) {
    return jsonErrorResponse('approveCliRequest', error, request)
  }
}

export async function cliAuthorizeEndpoint(request: Request): Promise<Response> {
  try {
    const db = getDb()
    await sweepExpiredCliVerificationRowsBestEffort(db)
    return await authorizeCliRequest(request, {
      baseUrl: getDbConfig().baseUrl,
      getSession: loadActiveCliSession,
      insertPending: async (row) => {
        await db.insert(verification).values(row)
      },
    })
  } catch (error) {
    return jsonErrorResponse('cliAuthorizeEndpoint', error, request)
  }
}

export async function cliApproveEndpoint(request: Request): Promise<Response> {
  try {
    const db = getDb()
    return await approveCliRequest(request, {
      getSession: loadActiveCliSession,
      consumePending: async (consent) => {
        const rows = await db
          .delete(verification)
          .where(eq(verification.identifier, pendingIdentifier(consent)))
          .returning()
        const row = rows[0]
        if (!row || row.expiresAt.getTime() < Date.now()) {
          return undefined
        }
        return parsePendingValue(row.value)
      },
      insertVerification: async (row) => {
        await db.insert(verification).values(row)
      },
    })
  } catch (error) {
    return jsonErrorResponse('cliApproveEndpoint', error, request)
  }
}

export async function cliExchangeEndpoint(request: Request): Promise<Response> {
  try {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405)
    }
    const db = getDb()
    const config = getDbConfig()
    const input = await readBoundedJsonObject(request, CLI_SMALL_BODY_LIMIT_BYTES)
    const code = readString(input, 'code')
    const verifier = readString(input, 'verifier')
    const rows = await db
      .delete(verification)
      .where(eq(verification.identifier, codeIdentifier(code)))
      .returning()
    const row = rows[0]
    if (!row) {
      throw new HttpError(400, 'authorization code is invalid or already used')
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new HttpError(400, 'authorization code expired')
    }
    const value = parseVerificationValue(row.value)
    if (value.challenge !== hash(verifier)) {
      throw new HttpError(400, 'authorization verifier rejected')
    }

    const sessionUser = await db.query.user.findFirst({
      where: eq(user.id, value.userId),
    })
    if (!sessionUser) {
      throw new HttpError(400, 'authorization user not found')
    }
    if (isUserActivelyBanned({ banned: sessionUser.banned, banExpires: sessionUser.banExpires })) {
      throw new HttpError(403, 'account is suspended')
    }

    const token = await mintApiTokenForUser(db, {
      userId: sessionUser.id,
      name: `press cli ${new Date().toISOString()}`,
    })

    return jsonResponse({
      token,
      user: {
        id: sessionUser.id,
        email: sessionUser.email,
        role: roleForEmail(sessionUser.email, config.adminEmails),
      },
    })
  } catch (error) {
    return jsonErrorResponse('cliExchangeEndpoint', error, request)
  }
}

export async function cliWhoamiEndpoint(request: Request): Promise<Response> {
  try {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'method not allowed' }, 405)
    }
    const verified = await verifyApiToken(getDb(), request.headers, getDbConfig().adminEmails)
    if (!verified) {
      throw new HttpError(401, 'valid bearer token required')
    }
    return jsonResponse({ user: verified.user })
  } catch (error) {
    return jsonErrorResponse('cliWhoamiEndpoint', error, request)
  }
}

export async function cliLogoutEndpoint(request: Request): Promise<Response> {
  try {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405)
    }
    const db = getDb()
    const verified = await verifyApiToken(db, request.headers, getDbConfig().adminEmails)
    if (!verified) {
      throw new HttpError(401, 'valid bearer token required')
    }
    await db.transaction(async (tx) => {
      await tx
        .update(apiToken)
        .set({ revokedAt: new Date() })
        .where(eq(apiToken.id, verified.tokenId))
      await tx.insert(auditEvent).values({
        id: randomUUID(),
        userId: verified.user.id,
        action: 'token-revoke',
        collectionSlug: null,
      })
    })
    return jsonResponse({ ok: true })
  } catch (error) {
    return jsonErrorResponse('cliLogoutEndpoint', error, request)
  }
}
