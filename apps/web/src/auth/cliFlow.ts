import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import { db, dbConfig } from '../db/client'
import { apiToken, auditEvent, user, verification } from '../db/schema'
import { BodyTooLargeError, readCappedBodyText } from '../http/readBody'
import { auth } from './server'
import { mintApiTokenForUser, verifyApiToken } from './apiTokens'

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

type CliVerificationValue = {
  readonly kind: 'cli-loopback'
  readonly userId: string
  readonly challenge: string
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

type CliPendingValue = {
  readonly kind: 'cli-pending'
  readonly userId: string
  readonly port: number
  readonly challenge: string
  // Client-chosen state, bound server-side in the pending record: it is echoed
  // in the loopback callback so the CLI's own state check passes, but it never
  // serves as the CSRF secret (that is the server-generated consent token).
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

function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

function codeIdentifier(code: string): string {
  return `cli:${hash(code)}`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// Same-origin approval page (B-1 / F-12-17): the loopback code is minted only
// after the user clicks Approve on this page, so a bare GET from a malicious
// page can no longer convert an ambient session into a long-lived token. Plain
// HTML + inline styles + strict CSP — press chrome is not required here.
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
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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

function parseChallenge(value: string | null): string {
  if (!value || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new HttpError(400, 'challenge is required')
  }
  return value
}

function parseState(value: string | null): string {
  if (!value || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new HttpError(400, 'state is required')
  }
  return value
}

function parseConsent(value: string | null): string {
  if (!value || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new HttpError(400, 'consent is required')
  }
  return value
}

// The pending record is keyed by the server-generated consent token (the CSRF
// secret the approval page posts), never by the client-chosen state.
function pendingIdentifier(consent: string): string {
  return `cli:pending:${hash(consent)}`
}

function parsePendingValue(value: string): CliPendingValue {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object') {
    throw new HttpError(400, 'authorization request is invalid')
  }
  const record = parsed as Partial<CliPendingValue>
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

// Codes, verifiers, and consent states are tiny, so the small-body cap stays
// far below PRESS_MAX_UPLOAD_BYTES (M-3).
const CLI_SMALL_BODY_LIMIT_BYTES = 8 * 1024

// The pending consent record outlives the code it guards: a human needs time
// to read and click Approve, then the code itself stays short-lived once minted.
const CLI_PENDING_TTL_MS = 10 * 60 * 1000
const CLI_CODE_TTL_MS = 5 * 60 * 1000

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  // Bounded read before parse: an anonymous caller must never make the server
  // buffer an unbounded body (M-3).
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

async function readFormConsent(request: Request): Promise<string> {
  // Same bounded read as the exchange: the approval POST is small and
  // session-bearing, but an oversized body must still fail before buffering.
  const text = await readCappedBodyText(request, CLI_SMALL_BODY_LIMIT_BYTES)
  const params = new URLSearchParams(text)
  return parseConsent(params.get('consent'))
}

function readString(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${field} is required`)
  }
  return value
}

function parseVerificationValue(value: string): CliVerificationValue {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object') {
    throw new HttpError(400, 'authorization code is invalid')
  }
  const record = parsed as Partial<CliVerificationValue>
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

export async function authorizeCliRequest(
  request: Request,
  dependencies: CliAuthorizeDependencies,
): Promise<Response> {
  try {
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405)
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
    const challenge = parseChallenge(url.searchParams.get('challenge'))
    const state = parseState(url.searchParams.get('state'))
    const now = dependencies.now?.() ?? Date.now()

    // B-1 consent step: the server binds state/port/challenge to this session
    // as a pending record and renders a same-origin approval page; the loopback
    // code is minted only after the CSRF-protected POST below. The CSRF secret
    // is a server-generated consent token (never the client-chosen state), so
    // a bare GET — or a forged same-site POST without the token — can never
    // convert an ambient session into a long-lived token.
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
    return errorResponse(error)
  }
}

// B-1 consent POST: consumes the server-owned pending record and mints the
// one-time loopback code. CSRF is defeated by the server-generated consent
// token: the approving page is same-origin (strict CSP, no-store), the token
// is unguessable and never exposed to other origins, and the approving session
// must be the one that started the request — so a hostile same-site page that
// knows the client state but not the consent token cannot forge the POST.
export async function approveCliRequest(
  request: Request,
  dependencies: CliApproveDependencies,
): Promise<Response> {
  try {
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405)
    }
    const session = await dependencies.getSession(request.headers)
    if (!session) {
      return json({ error: 'authentication required' }, 401)
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

    // Echo the server-bound client state (not the consent token) so the CLI's
    // own callback state check passes unchanged.
    const redirectUrl = new URL(`http://127.0.0.1:${pending.port}/callback`)
    redirectUrl.searchParams.set('code', code)
    redirectUrl.searchParams.set('state', pending.state)
    return Response.redirect(redirectUrl.toString(), 302)
  } catch (error) {
    return errorResponse(error)
  }
}

export async function cliAuthorizeEndpoint(request: Request): Promise<Response> {
  try {
    return await authorizeCliRequest(request, {
      baseUrl: dbConfig.baseUrl,
      // The admin plugin used to type session.impersonatedBy; the column is still
      // written by Better Auth at runtime, so the read-site contract stands.
      getSession: async (headers) =>
        (await auth.api.getSession({ headers })) as CliAuthorizeSession | null,
      insertPending: async (row) => {
        await db.insert(verification).values(row)
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function cliApproveEndpoint(request: Request): Promise<Response> {
  try {
    return await approveCliRequest(request, {
      getSession: async (headers) =>
        (await auth.api.getSession({ headers })) as CliAuthorizeSession | null,
      consumePending: async (state) => {
        const rows = await db
          .delete(verification)
          .where(eq(verification.identifier, pendingIdentifier(state)))
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
    return errorResponse(error)
  }
}

export async function cliExchangeEndpoint(request: Request): Promise<Response> {
  try {
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405)
    }
    const input = await readJsonObject(request)
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

    const token = await mintApiTokenForUser(db, {
      userId: value.userId,
      name: `press cli ${new Date().toISOString()}`,
    })
    const sessionUser = await db.query.user.findFirst({
      where: eq(user.id, value.userId),
    })
    if (!sessionUser) {
      throw new HttpError(400, 'authorization user not found')
    }

    return json({
      token,
      user: {
        id: sessionUser.id,
        email: sessionUser.email,
        role: sessionUser.role,
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function cliWhoamiEndpoint(request: Request): Promise<Response> {
  try {
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405)
    }
    const verified = await verifyApiToken(db, request.headers, dbConfig.adminEmails)
    if (!verified) {
      throw new HttpError(401, 'valid bearer token required')
    }
    return json({ user: verified.user })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function cliLogoutEndpoint(request: Request): Promise<Response> {
  try {
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405)
    }
    const verified = await verifyApiToken(db, request.headers, dbConfig.adminEmails)
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
    return json({ ok: true })
  } catch (error) {
    return errorResponse(error)
  }
}
