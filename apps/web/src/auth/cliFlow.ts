import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import { db, dbConfig } from '../db/client'
import { user, verification } from '../db/schema'
import { auth } from './server'
import { mintApiTokenForUser, revokeApiToken, verifyApiToken } from './apiTokens'

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

export async function cliAuthorizeEndpoint(request: Request): Promise<Response> {
  try {
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405)
    }
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session) {
      const next = new URL(request.url).pathname + new URL(request.url).search
      return Response.redirect(`${dbConfig.baseUrl}/login?next=${encodeURIComponent(next)}`, 302)
    }

    const url = new URL(request.url)
    const port = parsePort(url.searchParams.get('port'))
    const challenge = parseChallenge(url.searchParams.get('challenge'))
    const code = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000)

    await db.insert(verification).values({
      id: randomUUID(),
      identifier: codeIdentifier(code),
      value: JSON.stringify({
        kind: 'cli-loopback',
        userId: session.user.id,
        challenge,
      } satisfies CliVerificationValue),
      expiresAt,
    })

    return Response.redirect(
      `http://127.0.0.1:${port}/callback?code=${encodeURIComponent(code)}`,
      302,
    )
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
    await revokeApiToken(db, verified.tokenId)
    return json({ ok: true })
  } catch (error) {
    return errorResponse(error)
  }
}
