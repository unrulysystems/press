import { describe, expect, test } from 'bun:test'

import {
  RESERVED_COLLECTION_SLUGS,
  SlugValidationError,
  parseCollectionSlug,
  parseFileSlug,
} from './index'

describe('collection slug grammar', () => {
  test.each(['reports', 'q2-report', 'a', 'a'.padEnd(63, '1')])('accepts %s', (slug) => {
    expect(String(parseCollectionSlug(slug))).toBe(slug)
  })

  test.each(['', '-reports', 'Reports', 'reports_', 'reports.html', 'a'.padEnd(64, '1')])(
    'rejects malformed collection slug %s',
    (slug) => {
      expect(() => parseCollectionSlug(slug)).toThrow(SlugValidationError)
    },
  )

  test.each([...RESERVED_COLLECTION_SLUGS])('rejects reserved collection slug %s', (slug) => {
    expect(() => parseCollectionSlug(slug)).toThrow(SlugValidationError)
  })
})

describe('file slug grammar', () => {
  test.each(['index.html', 'report-2026.html', 'q2.final_v1.html', 'a'.padEnd(116, '1') + '.html'])(
    'accepts %s',
    (slug) => {
      expect(String(parseFileSlug(slug))).toBe(slug)
    },
  )

  test.each([
    '',
    'report',
    'Report.html',
    '/report.html',
    '../evil.html',
    'a..b.html',
    'reports/evil.html',
    'reports%2Fevil.html',
    'a'.padEnd(122, '1') + '.html',
  ])('rejects malformed or traversal-shaped file slug %s', (slug) => {
    expect(() => parseFileSlug(slug)).toThrow(SlugValidationError)
  })
})
