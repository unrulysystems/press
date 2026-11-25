import { describe, expect, test } from 'bun:test'

import { readMutationJson } from './routes'

function jsonRequest(body: string): Request {
  return new Request('http://press.test/api/pages/reports/index.html', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

describe('readMutationJson', () => {
  test('parses a valid JSON object', async () => {
    const input = await readMutationJson(
      jsonRequest(JSON.stringify({ visibility: 'public' })),
      1024,
    )
    expect(input).toEqual({ visibility: 'public' })
  })

  test('rejects an oversized body with BodyTooLargeError (413)', async () => {
    await expect(
      readMutationJson(jsonRequest(JSON.stringify({ title: 'x'.repeat(64) })), 32),
    ).rejects.toMatchObject({ status: 413 })
  })

  test('rejects malformed JSON', async () => {
    await expect(readMutationJson(jsonRequest('not json'), 1024)).rejects.toThrow(
      'request body must be JSON',
    )
  })

  test('rejects a JSON array', async () => {
    await expect(readMutationJson(jsonRequest('[1,2,3]'), 1024)).rejects.toThrow(
      'request body must be a JSON object',
    )
  })
})
