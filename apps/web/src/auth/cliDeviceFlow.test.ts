import { createHash } from 'node:crypto'

import { beforeAll, describe, expect, test } from 'bun:test'

import type {
  CliDeviceActivateDependencies,
  CliDeviceGrant,
  CliDevicePollDependencies,
  CliDeviceStartDependencies,
  VerificationInsert,
} from './cliDeviceFlow'

type DeviceFlowModule = typeof import('./cliDeviceFlow')

let deviceFlow: DeviceFlowModule

beforeAll(async () => {
  process.env.NODE_ENV = 'development'
  process.env.PRESS_BASE_URL = 'http://press.test'
  process.env.PRESS_ALLOWED_DOMAINS = 'send.it'
  process.env.PRESS_ADMIN_EMAILS = 'admin@send.it'
  process.env.DATABASE_URL = 'postgres://press:press@127.0.0.1:54329/press'
  process.env.PRESS_STORAGE_DIR = '.press/test/storage'
  process.env.BETTER_AUTH_SECRET = 'test-secret-at-least-32-bytes-long'
  process.env.PRESS_ENABLE_CREDENTIAL_AUTH = '1'
  deviceFlow = await import('./cliDeviceFlow')
})

const ownerSession = {
  user: { id: 'owner-user', email: 'owner@send.it' },
  session: {},
} as const

const CHALLENGE = 'a'.repeat(32)
const VERIFIER = 'verifier-value-for-pkce-tests-xx'
const DEVICE_CODE = 'd'.repeat(32)
const USER_CODE = 'ABCD2345'
const CONSENT = 'c'.repeat(32)

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function startRequest(body: unknown = { challenge: CHALLENGE }): Request {
  return new Request('http://press.test/api/cli/device/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function pollRequest(body: unknown): Request {
  return new Request('http://press.test/api/cli/device/poll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function activateGet(userCode?: string): Request {
  const url = new URL('http://press.test/cli/activate')
  if (userCode) {
    url.searchParams.set('user_code', userCode)
  }
  return new Request(url)
}

function activatePost(input: {
  readonly consent: string
  readonly userCode: string
  readonly action: 'approve' | 'deny'
}): Request {
  const body = new URLSearchParams({
    consent: input.consent,
    user_code: input.userCode,
    action: input.action,
  })
  return new Request('http://press.test/cli/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
}

type Memory = {
  readonly rows: Map<string, VerificationInsert>
  minted: string[]
  startAllowed: boolean
  activateAllowed: boolean
}

function createMemory(): Memory {
  return {
    rows: new Map(),
    minted: [],
    startAllowed: true,
    activateAllowed: true,
  }
}

function startDeps(
  memory: Memory,
  extra: Partial<CliDeviceStartDependencies> = {},
): CliDeviceStartDependencies {
  return {
    baseUrl: 'http://press.test',
    now: () => 0,
    randomDeviceCode: () => DEVICE_CODE,
    randomUserCode: () => USER_CODE,
    randomId: () => 'row-id',
    async consumeStartLimit() {
      return memory.startAllowed
    },
    async insertRow(row) {
      memory.rows.set(row.identifier, row)
    },
    async hasIdentifier(identifier) {
      return memory.rows.has(identifier)
    },
    ...extra,
  }
}

function pollDeps(
  memory: Memory,
  extra: Partial<CliDevicePollDependencies> = {},
): CliDevicePollDependencies {
  return {
    now: () => 0,
    async loadRow(identifier) {
      return memory.rows.get(identifier)
    },
    async saveRow(row) {
      memory.rows.set(row.identifier, row)
    },
    async consumeRow(identifier) {
      const row = memory.rows.get(identifier)
      if (!row) {
        return undefined
      }
      memory.rows.delete(identifier)
      return row
    },
    async mintToken(userId) {
      memory.minted.push(userId)
      return {
        token: 'press_minted-token',
        user: { id: userId, email: 'owner@send.it', role: 'user' },
      }
    },
    ...extra,
  }
}

function activateDeps(
  memory: Memory,
  extra: Partial<CliDeviceActivateDependencies> = {},
): CliDeviceActivateDependencies {
  return {
    baseUrl: 'http://press.test',
    async getSession() {
      return ownerSession
    },
    now: () => 0,
    randomConsent: () => CONSENT,
    randomId: () => 'consent-id',
    async consumeActivateLimit() {
      return memory.activateAllowed
    },
    async insertRow(row) {
      memory.rows.set(row.identifier, row)
    },
    async consumeRow(identifier) {
      const row = memory.rows.get(identifier)
      if (!row) {
        return undefined
      }
      memory.rows.delete(identifier)
      return row
    },
    async loadRow(identifier) {
      return memory.rows.get(identifier)
    },
    async saveRow(row) {
      memory.rows.set(row.identifier, row)
    },
    ...extra,
  }
}

async function startGrant(memory: Memory, challenge = CHALLENGE): Promise<void> {
  const response = await deviceFlow.startCliDeviceRequest(
    startRequest({ challenge }),
    startDeps(memory),
  )
  expect(response.status).toBe(200)
}

function grantFromMemory(memory: Memory): CliDeviceGrant {
  const row = memory.rows.get(deviceFlow.deviceGrantIdentifier(DEVICE_CODE))
  if (!row) {
    throw new Error('device grant missing')
  }
  return deviceFlow.parseDeviceGrant(row.value)
}

describe('nextRateLimitState', () => {
  test('increments inside the window and resets after it', () => {
    expect(deviceFlow.nextRateLimitState(null, 1000, 60_000)).toEqual({
      count: 1,
      windowStart: 1000,
    })
    expect(deviceFlow.nextRateLimitState({ count: 3, windowStart: 1000 }, 2000, 60_000)).toEqual({
      count: 4,
      windowStart: 1000,
    })
    expect(deviceFlow.nextRateLimitState({ count: 3, windowStart: 1000 }, 61_000, 60_000)).toEqual({
      count: 1,
      windowStart: 61_000,
    })
  })
})

describe('deviceStartRateLimitKey', () => {
  test('ignores X-Forwarded-For so callers cannot choose their rate-limit identity', () => {
    const spoofed = new Request('http://press.test/api/cli/device/start', {
      headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.2' },
    })
    const other = new Request('http://press.test/api/cli/device/start', {
      headers: { 'x-forwarded-for': '198.51.100.7' },
    })
    const direct = new Request('http://press.test/api/cli/device/start')
    expect(deviceFlow.deviceStartRateLimitKey(spoofed)).toBe(deviceFlow.DEVICE_START_RATE_LIMIT_KEY)
    expect(deviceFlow.deviceStartRateLimitKey(other)).toBe(
      deviceFlow.deviceStartRateLimitKey(spoofed),
    )
    expect(deviceFlow.deviceStartRateLimitKey(direct)).toBe(
      deviceFlow.deviceStartRateLimitKey(spoofed),
    )
  })
})

describe('user-code helpers', () => {
  test('normalizes hyphens, spaces, and case, then formats XXXX-XXXX', () => {
    expect(deviceFlow.normalizeUserCode('ab cd-2345')).toBe('ABCD2345')
    expect(deviceFlow.formatUserCode('ABCD2345')).toBe('ABCD-2345')
    expect(deviceFlow.isNormalizedUserCode('ABCD2345')).toBe(true)
    expect(deviceFlow.isNormalizedUserCode('ABCD234I')).toBe(false)
  })

  test('generateUserCode maps entropy onto the unambiguous alphabet', () => {
    const code = deviceFlow.generateUserCode(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]))
    expect(code).toHaveLength(8)
    expect(deviceFlow.isNormalizedUserCode(code)).toBe(true)
    expect(code[0]).toBe(deviceFlow.USER_CODE_ALPHABET[0])
  })
})

describe('startCliDeviceRequest', () => {
  test('issues a device secret, user code, and verification URI without an API token', async () => {
    const memory = createMemory()
    const response = await deviceFlow.startCliDeviceRequest(startRequest(), startDeps(memory))
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.device_code).toBe(DEVICE_CODE)
    expect(body.user_code).toBe('ABCD-2345')
    expect(body.verification_uri).toBe('http://press.test/cli/activate')
    expect(body.verification_uri_complete).toBe(
      'http://press.test/cli/activate?user_code=ABCD-2345',
    )
    expect(body.expires_in).toBe(deviceFlow.CLI_DEVICE_TTL_MS / 1000)
    expect(body.interval).toBe(deviceFlow.CLI_DEVICE_INTERVAL_SECONDS)
    expect(JSON.stringify(body)).not.toContain('press_')
    expect(memory.rows.has(deviceFlow.deviceGrantIdentifier(DEVICE_CODE))).toBe(true)
    expect(memory.rows.has(deviceFlow.userCodeIdentifier(USER_CODE))).toBe(true)
    const grant = grantFromMemory(memory)
    expect(grant.userId).toBeNull()
    expect(grant.denied).toBe(false)
    expect(grant.challenge).toBe(CHALLENGE)
  })

  test('rejects a missing challenge and an oversized body without storing a grant', async () => {
    const memory = createMemory()
    const missing = await deviceFlow.startCliDeviceRequest(startRequest({}), startDeps(memory))
    expect(missing.status).toBe(400)
    await expect(missing.json()).resolves.toEqual({ error: 'challenge is required' })

    const oversized = await deviceFlow.startCliDeviceRequest(
      new Request('http://press.test/api/cli/device/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(deviceFlow.CLI_SMALL_BODY_LIMIT_BYTES + 1),
      }),
      startDeps(memory),
    )
    expect(oversized.status).toBe(413)
    expect(memory.rows.size).toBe(0)
  })

  test('rate-limits start with the global key even when X-Forwarded-For is set', async () => {
    const memory = createMemory()
    const keys: string[] = []
    const response = await deviceFlow.startCliDeviceRequest(
      new Request('http://press.test/api/cli/device/start', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.9',
        },
        body: JSON.stringify({ challenge: CHALLENGE }),
      }),
      startDeps(memory, {
        async consumeStartLimit(key) {
          keys.push(key)
          return true
        },
      }),
    )
    expect(response.status).toBe(200)
    expect(keys).toEqual([deviceFlow.DEVICE_START_RATE_LIMIT_KEY])
  })

  test('rate-limits start without creating a grant', async () => {
    const memory = createMemory()
    memory.startAllowed = false
    const response = await deviceFlow.startCliDeviceRequest(startRequest(), startDeps(memory))
    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toEqual({ error: 'rate limited' })
    expect(memory.rows.size).toBe(0)
  })
})

describe('pollCliDeviceRequest', () => {
  test('returns authorization_pending and does not mint before approve', async () => {
    const memory = createMemory()
    await startGrant(memory)
    const response = await deviceFlow.pollCliDeviceRequest(
      pollRequest({ device_code: DEVICE_CODE, verifier: VERIFIER }),
      pollDeps(memory, { now: () => 10_000 }),
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'authorization_pending' })
    expect(memory.minted).toEqual([])
    expect(memory.rows.has(deviceFlow.deviceGrantIdentifier(DEVICE_CODE))).toBe(true)
  })

  test('returns slow_down when polled before the interval elapses', async () => {
    const memory = createMemory()
    await startGrant(memory)
    const first = await deviceFlow.pollCliDeviceRequest(
      pollRequest({ device_code: DEVICE_CODE, verifier: VERIFIER }),
      pollDeps(memory, { now: () => 1000 }),
    )
    expect(first.status).toBe(400)
    const second = await deviceFlow.pollCliDeviceRequest(
      pollRequest({ device_code: DEVICE_CODE, verifier: VERIFIER }),
      pollDeps(memory, { now: () => 2000 }),
    )
    expect(second.status).toBe(400)
    await expect(second.json()).resolves.toEqual({ error: 'slow_down' })
    expect(memory.minted).toEqual([])
    expect(grantFromMemory(memory).intervalSeconds).toBe(
      deviceFlow.CLI_DEVICE_INTERVAL_SECONDS + deviceFlow.CLI_DEVICE_SLOW_DOWN_SECONDS,
    )
  })

  test('returns expired_token after TTL and does not mint', async () => {
    const memory = createMemory()
    await startGrant(memory)
    const response = await deviceFlow.pollCliDeviceRequest(
      pollRequest({ device_code: DEVICE_CODE, verifier: VERIFIER }),
      pollDeps(memory, { now: () => deviceFlow.CLI_DEVICE_TTL_MS + 1 }),
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'expired_token' })
    expect(memory.minted).toEqual([])
  })

  test('returns invalid_grant for an unknown device code', async () => {
    const memory = createMemory()
    const response = await deviceFlow.pollCliDeviceRequest(
      pollRequest({ device_code: 'z'.repeat(32), verifier: VERIFIER }),
      pollDeps(memory),
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'invalid_grant' })
    expect(memory.minted).toEqual([])
  })
})

describe('activateCliDeviceRequest', () => {
  test('GET sends anonymous sessions to login and does not store a consent row', async () => {
    const memory = createMemory()
    const response = await deviceFlow.activateCliDeviceRequest(
      activateGet('ABCD-2345'),
      activateDeps(memory, {
        async getSession() {
          return null
        },
      }),
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('/login?next=')
    expect(memory.rows.size).toBe(0)
  })

  test('GET with a prefilled user code does not bind or mint a grant', async () => {
    const memory = createMemory()
    await startGrant(memory)
    const response = await deviceFlow.activateCliDeviceRequest(
      activateGet('ABCD-2345'),
      activateDeps(memory),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self'")
    expect(response.headers.get('content-security-policy')).not.toContain('127.0.0.1')
    const html = await response.text()
    expect(html).toContain('Approve CLI sign-in?')
    expect(html).toContain('name="consent" value="cccccccccccccccccccccccccccccccc"')
    expect(html).toContain('ABCD-2345')
    expect(html).toContain('owner@send.it')
    expect(html).not.toContain('press_minted-token')
    expect(grantFromMemory(memory).userId).toBeNull()
    expect(memory.minted).toEqual([])
  })

  test('rejects impersonated sessions on GET and POST', async () => {
    const memory = createMemory()
    const impersonated = {
      async getSession() {
        return {
          user: { id: 'target-user' },
          session: { impersonatedBy: 'admin-user' },
        }
      },
    }
    const get = await deviceFlow.activateCliDeviceRequest(
      activateGet(),
      activateDeps(memory, impersonated),
    )
    expect(get.status).toBe(403)
    const post = await deviceFlow.activateCliDeviceRequest(
      activatePost({ consent: CONSENT, userCode: 'ABCD-2345', action: 'approve' }),
      activateDeps(memory, impersonated),
    )
    expect(post.status).toBe(403)
    expect(memory.minted).toEqual([])
  })

  test('rejects a forged POST whose consent token the server never issued', async () => {
    const memory = createMemory()
    await startGrant(memory)
    const response = await deviceFlow.activateCliDeviceRequest(
      activatePost({ consent: 'f'.repeat(32), userCode: 'ABCD-2345', action: 'approve' }),
      activateDeps(memory),
    )
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('authorization request is invalid or expired')
    expect(grantFromMemory(memory).userId).toBeNull()
    expect(memory.minted).toEqual([])
  })

  test('approve without a matching user code stays generic and does not mint', async () => {
    const memory = createMemory()
    await startGrant(memory)
    await deviceFlow.activateCliDeviceRequest(activateGet(), activateDeps(memory))
    const response = await deviceFlow.activateCliDeviceRequest(
      activatePost({ consent: CONSENT, userCode: 'ZZZZ9999', action: 'approve' }),
      activateDeps(memory),
    )
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('authorization request is invalid or expired')
    expect(html).not.toContain('not found')
    expect(grantFromMemory(memory).userId).toBeNull()
    expect(memory.minted).toEqual([])
  })

  test('POST requires a session', async () => {
    const memory = createMemory()
    const response = await deviceFlow.activateCliDeviceRequest(
      activatePost({ consent: CONSENT, userCode: 'ABCD-2345', action: 'approve' }),
      activateDeps(memory, {
        async getSession() {
          return null
        },
      }),
    )
    expect(response.status).toBe(401)
  })
})

describe('device grant happy path', () => {
  test('matching PKCE verifier after approve mints once; a second poll is invalid', async () => {
    const memory = createMemory()
    const challenge = challengeFor(VERIFIER)
    await startGrant(memory, challenge)

    const pending = await deviceFlow.pollCliDeviceRequest(
      pollRequest({ device_code: DEVICE_CODE, verifier: VERIFIER }),
      pollDeps(memory, { now: () => 10_000 }),
    )
    expect(pending.status).toBe(400)
    await expect(pending.json()).resolves.toEqual({ error: 'authorization_pending' })
    expect(memory.minted).toEqual([])

    await deviceFlow.activateCliDeviceRequest(activateGet('ABCD-2345'), activateDeps(memory))
    const approved = await deviceFlow.activateCliDeviceRequest(
      activatePost({ consent: CONSENT, userCode: 'ab cd-2345', action: 'approve' }),
      activateDeps(memory),
    )
    expect(approved.status).toBe(200)
    const approvedHtml = await approved.text()
    expect(approvedHtml).toContain('CLI sign-in approved')
    expect(approvedHtml).not.toContain('press_minted-token')
    expect(grantFromMemory(memory).userId).toBe('owner-user')

    const wrongVerifier = await deviceFlow.pollCliDeviceRequest(
      pollRequest({ device_code: DEVICE_CODE, verifier: 'wrong-verifier-value-xxxx' }),
      pollDeps(memory, { now: () => 20_000 }),
    )
    expect(wrongVerifier.status).toBe(400)
    await expect(wrongVerifier.json()).resolves.toEqual({ error: 'invalid_grant' })
    expect(memory.minted).toEqual([])

    const minted = await deviceFlow.pollCliDeviceRequest(
      pollRequest({ device_code: DEVICE_CODE, verifier: VERIFIER }),
      pollDeps(memory, { now: () => 20_000 }),
    )
    expect(minted.status).toBe(200)
    const body = (await minted.json()) as {
      readonly token?: string
      readonly user?: { readonly email?: string }
    }
    expect(body.token).toBe('press_minted-token')
    expect(body.user?.email).toBe('owner@send.it')
    expect(memory.minted).toEqual(['owner-user'])
    expect(memory.rows.has(deviceFlow.deviceGrantIdentifier(DEVICE_CODE))).toBe(false)

    const again = await deviceFlow.pollCliDeviceRequest(
      pollRequest({ device_code: DEVICE_CODE, verifier: VERIFIER }),
      pollDeps(memory, { now: () => 30_000 }),
    )
    expect(again.status).toBe(400)
    await expect(again.json()).resolves.toEqual({ error: 'invalid_grant' })
    expect(memory.minted).toEqual(['owner-user'])
  })

  test('a consume that races a deny after approve does not mint', async () => {
    const memory = createMemory()
    await startGrant(memory, challengeFor(VERIFIER))
    await deviceFlow.activateCliDeviceRequest(activateGet(), activateDeps(memory))
    await deviceFlow.activateCliDeviceRequest(
      activatePost({ consent: CONSENT, userCode: 'ABCD-2345', action: 'approve' }),
      activateDeps(memory),
    )
    const identifier = deviceFlow.deviceGrantIdentifier(DEVICE_CODE)
    const approved = memory.rows.get(identifier)
    if (!approved) {
      throw new Error('approved grant missing')
    }
    const polled = await deviceFlow.pollCliDeviceRequest(
      pollRequest({ device_code: DEVICE_CODE, verifier: VERIFIER }),
      pollDeps(memory, {
        now: () => 10_000,
        async loadRow(requested) {
          return requested === identifier ? approved : memory.rows.get(requested)
        },
        async consumeRow(requested) {
          if (requested !== identifier) {
            const row = memory.rows.get(requested)
            memory.rows.delete(requested)
            return row
          }
          memory.rows.delete(requested)
          return {
            ...approved,
            value: JSON.stringify({
              ...deviceFlow.parseDeviceGrant(approved.value),
              denied: true,
            }),
          }
        },
      }),
    )
    expect(polled.status).toBe(400)
    await expect(polled.json()).resolves.toEqual({ error: 'access_denied' })
    expect(memory.minted).toEqual([])
  })

  test('deny makes subsequent polls access_denied and never mints', async () => {
    const memory = createMemory()
    await startGrant(memory, challengeFor(VERIFIER))
    await deviceFlow.activateCliDeviceRequest(activateGet(), activateDeps(memory))
    const denied = await deviceFlow.activateCliDeviceRequest(
      activatePost({ consent: CONSENT, userCode: 'ABCD-2345', action: 'deny' }),
      activateDeps(memory),
    )
    expect(denied.status).toBe(200)
    expect(await denied.text()).toContain('CLI sign-in cancelled')

    const polled = await deviceFlow.pollCliDeviceRequest(
      pollRequest({ device_code: DEVICE_CODE, verifier: VERIFIER }),
      pollDeps(memory, { now: () => 10_000 }),
    )
    expect(polled.status).toBe(400)
    await expect(polled.json()).resolves.toEqual({ error: 'access_denied' })
    expect(memory.minted).toEqual([])
  })

  test('a second session cannot take over an already approved grant', async () => {
    const memory = createMemory()
    await startGrant(memory, challengeFor(VERIFIER))
    await deviceFlow.activateCliDeviceRequest(activateGet(), activateDeps(memory))
    const first = await deviceFlow.activateCliDeviceRequest(
      activatePost({ consent: CONSENT, userCode: 'ABCD-2345', action: 'approve' }),
      activateDeps(memory),
    )
    expect(first.status).toBe(200)

    await deviceFlow.activateCliDeviceRequest(
      activateGet(),
      activateDeps(memory, {
        randomConsent: () => 'e'.repeat(32),
        async getSession() {
          return { user: { id: 'other-user', email: 'second@send.it' }, session: {} }
        },
      }),
    )
    const stolen = await deviceFlow.activateCliDeviceRequest(
      activatePost({ consent: 'e'.repeat(32), userCode: 'ABCD-2345', action: 'approve' }),
      activateDeps(memory, {
        async getSession() {
          return { user: { id: 'other-user', email: 'second@send.it' }, session: {} }
        },
      }),
    )
    expect(stolen.status).toBe(200)
    expect(await stolen.text()).toContain('authorization request is invalid or expired')
    expect(grantFromMemory(memory).userId).toBe('owner-user')
  })
})
