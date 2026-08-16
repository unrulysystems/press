import { beforeAll, describe, expect, test } from 'bun:test'

type RoutesModule = typeof import('./routes')

let routes: RoutesModule

beforeAll(async () => {
  process.env.NODE_ENV = 'development'
  process.env.PRESS_BASE_URL = 'http://press.test'
  process.env.PRESS_ALLOWED_DOMAINS = 'send.it'
  process.env.PRESS_ADMIN_EMAILS = 'admin@send.it'
  process.env.DATABASE_URL = 'postgres://press:press@127.0.0.1:54329/press'
  process.env.PRESS_STORAGE_DIR = '.press/test/storage'
  process.env.BETTER_AUTH_SECRET = 'test-secret-at-least-32-bytes-long'
  process.env.PRESS_ENABLE_CREDENTIAL_AUTH = '1'
  routes = await import('./routes')
})

function jsonRequest(body: string): Request {
  return new Request('http://press.test/api/pages/reports/index.html', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

describe('readMutationJson (F-34)', () => {
  test('parses a valid JSON object', async () => {
    const input = await routes.readMutationJson(
      jsonRequest(JSON.stringify({ visibility: 'public' })),
      1024,
    )
    expect(input).toEqual({ visibility: 'public' })
  })

  test('rejects an oversized body with BodyTooLargeError (413)', async () => {
    await expect(
      routes.readMutationJson(jsonRequest(JSON.stringify({ title: 'x'.repeat(64) })), 32),
    ).rejects.toMatchObject({ status: 413 })
  })

  test('rejects malformed JSON', async () => {
    await expect(routes.readMutationJson(jsonRequest('not json'), 1024)).rejects.toThrow(
      'request body must be JSON',
    )
  })

  test('rejects a JSON array', async () => {
    await expect(routes.readMutationJson(jsonRequest('[1,2,3]'), 1024)).rejects.toThrow(
      'request body must be a JSON object',
    )
  })
})
