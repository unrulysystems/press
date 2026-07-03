import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import { db, dbConfig } from '../db/client'
import { apiToken, auditEvent, user, verification } from '../db/schema'
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
  }
  readonly session?: {
    readonly impersonatedBy?: string | null | undefined
  } | null
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
  readonly insertVerification: (row: VerificationInsert) => Promise<void>
  readonly now?: () => number
  readonly randomCode?: () => string
  readonly randomId?: () => string
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function errorResponse(error: unknown): Response {
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

function parseState(value: string | null): string | null {
  if (value === null) {
    return null
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new HttpError(400, 'state is invalid')
  }
  return value
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => {
    throw new HttpError(400, 'request body must be JSON')
  })
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
    const code = dependencies.randomCode?.() ?? randomBytes(32).toString('base64url')
    const now = dependencies.now?.() ?? Date.now()
    const expiresAt = new Date(now + 5 * 60 * 1000)

    await dependencies.insertVerification({
      id: dependencies.randomId?.() ?? randomUUID(),
      identifier: codeIdentifier(code),
      value: JSON.stringify({
        kind: 'cli-loopback',
        userId: session.user.id,
        challenge,
      } satisfies CliVerificationValue),
      expiresAt,
    })

    const redirectUrl = new URL(`http://127.0.0.1:${port}/callback`)
    redirectUrl.searchParams.set('code', code)
    if (state !== null) {
      redirectUrl.searchParams.set('state', state)
    }
    return Response.redirect(redirectUrl.toString(), 302)
  } catch (error) {
    return errorResponse(error)
  }
}

export async function cliAuthorizeEndpoint(request: Request): Promise<Response> {
  try {
    return await authorizeCliRequest(request, {
      baseUrl: dbConfig.baseUrl,
      getSession: async (headers) => await auth.api.getSession({ headers }),
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
    const verified = await verifyApiToken(db, request.headers)
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
    const verified = await verifyApiToken(db, request.headers)
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
