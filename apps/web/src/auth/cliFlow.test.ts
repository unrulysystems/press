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

describe('authorizeCliRequest', () => {
  test('rejects impersonated sessions without creating a verification row', async () => {
    const inserted: unknown[] = []
    const response = await cliFlow.authorizeCliRequest(new Request(authorizeUrl()), {
      baseUrl: 'http://press.test',
      async getSession() {
        return {
          user: { id: 'target-user' },
          session: { impersonatedBy: 'admin-user' },
        }
      },
      async insertVerification(row) {
        inserted.push(row)
      },
      randomCode: () => 'fixed-code',
      randomId: () => 'verification-id',
      now: () => 0,
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'cli authorization unavailable while impersonating',
    })
    expect(inserted).toEqual([])
  })

  test('echoes a validated loopback state in the redirect', async () => {
    const state = 's'.repeat(32)
    const response = await cliFlow.authorizeCliRequest(
      new Request(authorizeUrl(`&state=${state}`)),
      {
        baseUrl: 'http://press.test',
        async getSession() {
          return {
            user: { id: 'owner-user' },
            session: {},
          }
        },
        async insertVerification() {},
        randomCode: () => 'fixed-code',
        randomId: () => 'verification-id',
        now: () => 0,
      },
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      `http://127.0.0.1:4567/callback?code=fixed-code&state=${state}`,
    )
  })

  test('rejects unsafe loopback state values', async () => {
    const response = await cliFlow.authorizeCliRequest(
      new Request(authorizeUrl('&state=not safe')),
      {
        baseUrl: 'http://press.test',
        async getSession() {
          return {
            user: { id: 'owner-user' },
            session: {},
          }
        },
        async insertVerification() {},
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'state is invalid' })
  })
})
