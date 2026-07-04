import { describe, expect, test } from 'bun:test'

import { pagePasswordSource } from './pagePassword'

describe('pagePasswordSource (REQ-CLI-001 / F3)', () => {
  test('prefers PRESS_PAGE_PASSWORD when set', () => {
    expect(pagePasswordSource('liberty-1776', true)).toEqual({ kind: 'env', value: 'liberty-1776' })
    // env wins even when a TTY is available
    expect(pagePasswordSource('liberty-1776', false)).toEqual({
      kind: 'env',
      value: 'liberty-1776',
    })
  })

  test('reads stdin when no env and not a TTY (non-interactive)', () => {
    expect(pagePasswordSource(undefined, false)).toEqual({ kind: 'stdin' })
    expect(pagePasswordSource('', false)).toEqual({ kind: 'stdin' })
  })

  test('prompts when no env and attached to a TTY', () => {
    expect(pagePasswordSource(undefined, true)).toEqual({ kind: 'prompt' })
  })
})
