import { describe, expect, test } from 'bun:test'

import { parseFileSlug } from '@press/core'

import { extractTitle } from './title'

const slug = parseFileSlug('report.html')

describe('extractTitle', () => {
  test('decodes named HTML entities in the title (issue #6)', () => {
    expect(extractTitle('<title>SEL Quarterly &mdash; Issue No. 1</title>', slug)).toBe(
      'SEL Quarterly — Issue No. 1',
    )
    expect(extractTitle('<title>A &ndash; B</title>', slug)).toBe('A – B')
    expect(extractTitle('<title>Ben &amp; Jerry</title>', slug)).toBe('Ben & Jerry')
  })

  test('decodes numeric character references (decimal and hex)', () => {
    expect(extractTitle('<title>Em&#8212;dash</title>', slug)).toBe('Em—dash')
    expect(extractTitle('<title>Em&#x2014;dash</title>', slug)).toBe('Em—dash')
  })

  test('leaves literal Unicode punctuation untouched', () => {
    expect(extractTitle('<title>Already — an em dash</title>', slug)).toBe('Already — an em dash')
  })

  test('still collapses internal whitespace and trims', () => {
    expect(extractTitle('<title>\n  Spaced   &amp;   Title \n</title>', slug)).toBe(
      'Spaced & Title',
    )
  })

  test('falls back to the file slug when there is no usable title', () => {
    expect(extractTitle('<p>no title here</p>', slug)).toBe(slug)
    expect(extractTitle('<title>   </title>', slug)).toBe(slug)
  })

  test('returns an explicit override verbatim (already a plain string)', () => {
    expect(extractTitle('<title>ignored &mdash; me</title>', slug, 'Explicit Title')).toBe(
      'Explicit Title',
    )
  })
})
