import { beforeAll, describe, expect, test } from 'bun:test'

type CliFlowModule = typeof import('./cliFlow')

let cliFlow: CliFlowModule

beforeAll(async () => {
  process.env.NODE_ENV = 'development'
  process.env.PRESS_BASE_URL = 'http://press.test'
  process.env.PRESS_ALLOWED_DOMAINS = 'send.it'
  process.env.PRESS_ADMIN_EMAILS = 'admin@send.it'
  process.env.DATABASE_URL = 'postgres://press:press@127.0.0.1:54329/press'
  process.env.PRESS_STORAGE_DIR = '.press/test/storage'
  process.env.BETTER_AUTH_SECRET = 'test-secret-at-least-32-bytes-long'
  process.env.PRESS_ENABLE_CREDENTIAL_AUTH = '1'
  cliFlow = await import('./cliFlow')
})

function authorizeUrl(extra = ''): string {
  return `http://press.test/cli/authorize?port=4567&challenge=${'a'.repeat(32)}${extra}`
}

function approveRequest(consent: string): Request {
  return new Request('http://press.test/cli/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `consent=${encodeURIComponent(consent)}`,
  })
}

const ownerSession = {
  user: { id: 'owner-user', email: 'owner@send.it' },
  session: {},
} as const

const pendingForOwner = {
  kind: 'cli-pending',
  userId: 'owner-user',
  port: 4567,
  challenge: 'a'.repeat(32),
  state: 's'.repeat(32),
} as const

describe('authorizeCliRequest (B-1 consent step)', () => {
  test('rejects impersonated sessions without storing a pending record', async () => {
    const pendingInserts: unknown[] = []
    const response = await cliFlow.authorizeCliRequest(new Request(authorizeUrl()), {
      baseUrl: 'http://press.test',
      async getSession() {
        return {
          user: { id: 'target-user' },
          session: { impersonatedBy: 'admin-user' },
        }
      },
      async insertPending(row) {
        pendingInserts.push(row)
      },
      randomId: () => 'pending-id',
      now: () => 0,
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'cli authorization unavailable while impersonating',
    })
    expect(pendingInserts).toEqual([])
  })

  test('renders a same-origin approval page with a server-generated consent token, never a code', async () => {
    const state = 's'.repeat(32)
    const pendingInserts: Array<Record<string, unknown>> = []
    const response = await cliFlow.authorizeCliRequest(
      new Request(authorizeUrl(`&state=${state}`)),
      {
        baseUrl: 'http://press.test',
        async getSession() {
          return ownerSession
        },
        async insertPending(row) {
          pendingInserts.push(row)
        },
        randomId: () => 'pending-id',
        randomConsent: () => 'server-consent-token',
        now: () => 0,
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('Approve CLI sign-in?')
    expect(html).toContain('action="/cli/approve"')
    expect(html).toContain('name="consent" value="server-consent-token"')
    // The CSRF secret is server-generated: the page must not expose the
    // client-chosen state as a form value (it is bound server-side instead).
    expect(html).not.toContain(`name="state"`)
    expect(html).toContain('4567')
    expect(html).toContain('owner@send.it')

    expect(pendingInserts).toHaveLength(1)
    const pending = pendingInserts[0] as {
      readonly identifier: string
      readonly value: string
      readonly expiresAt: Date
    }
    expect(pending.identifier.startsWith('cli:pending:')).toBe(true)
    expect(JSON.parse(pending.value)).toEqual({
      kind: 'cli-pending',
      userId: 'owner-user',
      port: 4567,
      challenge: 'a'.repeat(32),
      state,
    })
    expect(pending.expiresAt.getTime()).toBe(10 * 60 * 1000)
  })

  test('sends unauthenticated sessions to sign in without storing a pending record', async () => {
    const pendingInserts: unknown[] = []
    const response = await cliFlow.authorizeCliRequest(new Request(authorizeUrl()), {
      baseUrl: 'http://press.test',
      async getSession() {
        return null
      },
      async insertPending(row) {
        pendingInserts.push(row)
      },
    })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('/login?next=')
    expect(pendingInserts).toEqual([])
  })

  test('requires the state nonce', async () => {
    const response = await cliFlow.authorizeCliRequest(new Request(authorizeUrl()), {
      baseUrl: 'http://press.test',
      async getSession() {
        return ownerSession
      },
      async insertPending() {},
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'state is required' })
  })

  test('rejects unsafe state values without storing a pending record', async () => {
    const pendingInserts: unknown[] = []
    const response = await cliFlow.authorizeCliRequest(
      new Request(authorizeUrl('&state=not safe')),
      {
        baseUrl: 'http://press.test',
        async getSession() {
          return ownerSession
        },
        async insertPending(row) {
          pendingInserts.push(row)
        },
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'state is required' })
    expect(pendingInserts).toEqual([])
  })
})

describe('approveCliRequest (B-1 consent POST)', () => {
  test('rejects non-POST requests', async () => {
    const response = await cliFlow.approveCliRequest(new Request('http://press.test/cli/approve'), {
      async getSession() {
        return ownerSession
      },
      async consumePending() {
        return undefined
      },
      async insertVerification() {},
    })

    expect(response.status).toBe(405)
  })

  test('requires an authenticated session', async () => {
    const response = await cliFlow.approveCliRequest(approveRequest('c'.repeat(32)), {
      async getSession() {
        return null
      },
      async consumePending() {
        return pendingForOwner
      },
      async insertVerification() {},
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'authentication required' })
  })

  test('rejects impersonated sessions', async () => {
    const response = await cliFlow.approveCliRequest(approveRequest('c'.repeat(32)), {
      async getSession() {
        return {
          user: { id: 'target-user' },
          session: { impersonatedBy: 'admin-user' },
        }
      },
      async consumePending() {
        return pendingForOwner
      },
      async insertVerification() {},
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'cli authorization unavailable while impersonating',
    })
  })

  // The reviewer-found gap (B-1 round 1, major): a hostile same-site page can
  // choose its own state and forge the approve POST with the session cookie.
  // The CSRF secret is the server-generated consent token, so a forged POST
  // (valid session, consent the server never issued) must fail closed.
  test('rejects a forged POST whose consent token the server never issued', async () => {
    // Well-formed shape, but the server never issued it: consumePending finds
    // no record, so the code must never be minted.
    const response = await cliFlow.approveCliRequest(approveRequest('f'.repeat(32)), {
      async getSession() {
        return ownerSession
      },
      async consumePending() {
        return undefined
      },
      async insertVerification() {},
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'authorization request is invalid or expired',
    })
  })

  test('requires a well-formed consent token', async () => {
    const response = await cliFlow.approveCliRequest(approveRequest('bad'), {
      async getSession() {
        return ownerSession
      },
      async consumePending() {
        return pendingForOwner
      },
      async insertVerification() {},
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'consent is required' })
  })

  test('rejects approval from a different session than the pending record', async () => {
    const response = await cliFlow.approveCliRequest(approveRequest('c'.repeat(32)), {
      async getSession() {
        return { user: { id: 'other-user' }, session: {} }
      },
      async consumePending() {
        return pendingForOwner
      },
      async insertVerification() {},
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'approval must come from the session that started the request',
    })
  })

  test('consumes the pending record, mints the code, and redirects to the loopback echoing the bound state', async () => {
    const consent = 'c'.repeat(32)
    const consumed: string[] = []
    const insertedCodes: Array<Record<string, unknown>> = []
    const response = await cliFlow.approveCliRequest(approveRequest(consent), {
      async getSession() {
        return ownerSession
      },
      async consumePending(requestedConsent) {
        consumed.push(requestedConsent)
        return pendingForOwner
      },
      async insertVerification(row) {
        insertedCodes.push(row)
      },
      randomCode: () => 'fixed-code',
      randomId: () => 'code-id',
      now: () => 0,
    })

    expect(response.status).toBe(302)
    // The loopback callback echoes the server-bound client state, never the
    // consent token, so the CLI's own callback state check still passes.
    expect(response.headers.get('location')).toBe(
      `http://127.0.0.1:4567/callback?code=fixed-code&state=${'s'.repeat(32)}`,
    )
    expect(consumed).toEqual([consent])
    expect(insertedCodes).toHaveLength(1)
    const code = insertedCodes[0] as {
      readonly identifier: string
      readonly value: string
      readonly expiresAt: Date
    }
    expect(code.identifier.startsWith('cli:')).toBe(true)
    expect(JSON.parse(code.value)).toEqual({
      kind: 'cli-loopback',
      userId: 'owner-user',
      challenge: 'a'.repeat(32),
    })
    expect(code.expiresAt.getTime()).toBe(5 * 60 * 1000)
  })
})
