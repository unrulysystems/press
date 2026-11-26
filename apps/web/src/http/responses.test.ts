import { describe, expect, spyOn, test } from 'bun:test'

import { SlugValidationError } from '@press/core'

import { BodyTooLargeError } from './readBody'
import {
  HttpError,
  escapeHtml,
  jsonErrorResponse,
  logServerWarning,
  readBoundedJsonObject,
} from './responses'

describe('jsonErrorResponse', () => {
  test('maps typed client errors to their HTTP status without logging a 5xx error', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const httpRes = jsonErrorResponse('testOp', new HttpError(403, 'forbidden'))
      expect(httpRes.status).toBe(403)
      await expect(httpRes.json()).resolves.toEqual({ error: 'forbidden' })

      const bodyRes = jsonErrorResponse('testOp', new BodyTooLargeError(1024))
      expect(bodyRes.status).toBe(413)
      expect(bodyRes.headers.get('connection')).toBe('close')

      const httpTooLarge = jsonErrorResponse('testOp', new HttpError(413, 'too large'))
      expect(httpTooLarge.status).toBe(413)
      expect(httpTooLarge.headers.get('connection')).toBe('close')

      const slugRes = jsonErrorResponse(
        'testOp',
        new SlugValidationError('collection', 'invalid slug'),
      )
      expect(slugRes.status).toBe(400)
      await expect(slugRes.json()).resolves.toEqual({ error: 'collection slug: invalid slug' })

      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  test('logs a structured JSON error record and returns generic 500 for unexpected errors', async () => {
    const logged: string[] = []
    const errorSpy = spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line))
    })
    try {
      const request = new Request('https://press.test/api/pages/reports/q1.html?secret=nope', {
        method: 'PUT',
      })
      const response = jsonErrorResponse('putPage', new Error('disk full'), request)
      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({ error: 'internal server error' })

      expect(logged).toHaveLength(1)
      const record = JSON.parse(logged[0]!) as Record<string, unknown>
      expect(record).toMatchObject({
        level: 'error',
        event: 'http_internal_error',
        operation: 'putPage',
        method: 'PUT',
        path: '/api/pages/reports/q1.html',
        errorName: 'Error',
        message: 'disk full',
      })
      // Query strings must never leak into logs.
      expect(logged[0]).not.toContain('secret=nope')
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('logServerWarning', () => {
  test('emits a structured JSON warning record', () => {
    const logged: string[] = []
    const warnSpy = spyOn(console, 'warn').mockImplementation((line: unknown) => {
      logged.push(String(line))
    })
    try {
      logServerWarning('cleanupBlob', { path: 'reports/q1.html' }, new Error('EACCES'))
      expect(logged).toHaveLength(1)
      expect(JSON.parse(logged[0]!)).toEqual({
        level: 'warn',
        event: 'server_warning',
        operation: 'cleanupBlob',
        path: 'reports/q1.html',
        errorName: 'Error',
        message: 'EACCES',
      })
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('readBoundedJsonObject', () => {
  test('parses a JSON object within the byte limit and rejects arrays, invalid JSON, and oversized bodies', async () => {
    const okReq = new Request('https://press.test/api/x', {
      method: 'POST',
      body: JSON.stringify({ visibility: 'public' }),
    })
    await expect(readBoundedJsonObject(okReq, 128)).resolves.toEqual({ visibility: 'public' })

    const arrayReq = new Request('https://press.test/api/x', { method: 'POST', body: '[1,2]' })
    await expect(readBoundedJsonObject(arrayReq, 128)).rejects.toMatchObject({ status: 400 })

    const badJsonReq = new Request('https://press.test/api/x', { method: 'POST', body: '{bad' })
    await expect(readBoundedJsonObject(badJsonReq, 128)).rejects.toMatchObject({ status: 400 })

    const bigReq = new Request('https://press.test/api/x', {
      method: 'POST',
      body: JSON.stringify({ a: 'x'.repeat(200) }),
    })
    await expect(readBoundedJsonObject(bigReq, 64)).rejects.toBeInstanceOf(BodyTooLargeError)
  })
})

describe('escapeHtml', () => {
  test('escapes all HTML special characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    )
  })
})
