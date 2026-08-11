import { describe, expect, test } from 'bun:test'

import { BodyTooLargeError, readCappedBodyText } from './readBody'

function requestWithBody(body: string): Request {
  return new Request('http://press.test/endpoint', { method: 'POST', body })
}

describe('readCappedBodyText (M-3)', () => {
  test('returns an under-limit body as text', async () => {
    await expect(readCappedBodyText(requestWithBody('hello'), 32)).resolves.toBe('hello')
  })

  test('returns an empty body', async () => {
    await expect(readCappedBodyText(requestWithBody(''), 32)).resolves.toBe('')
  })

  test('rejects an over-limit body with BodyTooLargeError', async () => {
    const body = 'x'.repeat(33)
    const rejection = await readCappedBodyText(requestWithBody(body), 32).catch((error) => error)
    expect(rejection).toBeInstanceOf(BodyTooLargeError)
    expect((rejection as BodyTooLargeError).status).toBe(413)
  })

  test('rejects exactly at the limit boundary', async () => {
    const rejection = await readCappedBodyText(requestWithBody('x'.repeat(33)), 32).catch(
      (error) => error,
    )
    expect(rejection).toBeInstanceOf(BodyTooLargeError)
    await expect(readCappedBodyText(requestWithBody('x'.repeat(32)), 32)).resolves.toHaveLength(32)
  })
})
