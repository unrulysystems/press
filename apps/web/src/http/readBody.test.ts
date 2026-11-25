import { describe, expect, test } from 'bun:test'

import { BodyTooLargeError, readCappedBodyText } from './readBody'

function requestWithBody(body: BodyInit): Request {
  return new Request('http://press.test/endpoint', { method: 'POST', body })
}

describe('readCappedBodyText', () => {
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

  test('enforces byte limits on multi-byte UTF-8 payloads', async () => {
    // 10 em-dashes = 10 UTF-16 code units, 30 UTF-8 bytes; 11 em-dashes = 33 bytes > 32.
    await expect(readCappedBodyText(requestWithBody('—'.repeat(10)), 32)).resolves.toBe(
      '—'.repeat(10),
    )
    await expect(readCappedBodyText(requestWithBody('—'.repeat(11)), 32)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    )
  })

  test('cancels a multi-chunk stream once the byte cap trips', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a'.repeat(20)))
        controller.enqueue(new TextEncoder().encode('b'.repeat(20)))
      },
      cancel() {
        cancelled = true
      },
    })

    await expect(readCappedBodyText(requestWithBody(stream), 32)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    )
    expect(cancelled).toBe(true)
  })
})
