import { describe, expect, test } from 'bun:test'

import { parseCollectionSlug, parseFileSlug } from '@press/core'

import { publishResponseBody } from './responseShape'

import type { PageVisibility } from '@press/core'

function body(visibility: PageVisibility, allowlist?: readonly string[], password?: string) {
  return publishResponseBody({
    baseUrl: 'https://press.test',
    collectionSlug: parseCollectionSlug('reports'),
    fileSlug: parseFileSlug('q3.html'),
    title: 'Q3',
    visibility,
    ...(allowlist ? { allowlist } : {}),
    ...(password ? { password } : {}),
  })
}

describe('publishResponseBody', () => {
  test('echoes the resolved allowlist for private pages (REQ-PUB-004 / F4)', () => {
    const result = body('private', ['a@send.it', 'b@send.it'])
    expect(result.allow).toEqual(['a@send.it', 'b@send.it'])
  })

  test('a private page with an empty allowlist echoes an empty list, not omitted', () => {
    const result = body('private', [])
    expect(result.allow).toEqual([])
  })

  test('non-private visibilities omit allow entirely', () => {
    for (const v of ['public', 'default', 'password'] as const) {
      expect(body(v, ['a@send.it']).allow).toBeUndefined()
    }
  })

  test('carries url/collection/file/title/visibility and password when present', () => {
    const result = body('password', undefined, 'one-time-secret')
    expect(result).toMatchObject({
      url: 'https://press.test/p/reports/q3.html',
      collection: 'reports',
      file: 'q3.html',
      title: 'Q3',
      visibility: 'password',
      password: 'one-time-secret',
    })
    expect(result.allow).toBeUndefined()
  })
})
