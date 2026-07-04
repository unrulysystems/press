import { describe, expect, test } from 'bun:test'

import {
  PAGE_PASSWORD_COOKIE_TTL_MS,
  pagePasswordCookieName,
  signPagePasswordCookie,
  verifyPagePasswordCookie,
} from './pagePasswordCookie'

const SECRET = 'localnet-secret-at-least-32-bytes-long'
const PAGE = 'demo-market-notes-secret.html'
const NOW = 1_000_000_000_000

describe('page password unlock cookie (REQ-SRV-004 / F1)', () => {
  test('cookie name is page-scoped', () => {
    expect(pagePasswordCookieName(PAGE)).toBe(`press_pw_${PAGE}`)
    expect(pagePasswordCookieName('other')).not.toBe(pagePasswordCookieName(PAGE))
  })

  test('a freshly signed cookie verifies for its page', () => {
    const value = signPagePasswordCookie(SECRET, PAGE, NOW + PAGE_PASSWORD_COOKIE_TTL_MS)
    expect(verifyPagePasswordCookie(SECRET, PAGE, value, NOW)).toBe(true)
  })

  test('rejects an expired cookie', () => {
    const value = signPagePasswordCookie(SECRET, PAGE, NOW - 1)
    expect(verifyPagePasswordCookie(SECRET, PAGE, value, NOW)).toBe(false)
  })

  test('rejects a cookie minted for a different page (page-scoped)', () => {
    const value = signPagePasswordCookie(SECRET, 'other-page', NOW + PAGE_PASSWORD_COOKIE_TTL_MS)
    expect(verifyPagePasswordCookie(SECRET, PAGE, value, NOW)).toBe(false)
  })

  test('rejects a tampered signature', () => {
    const value = signPagePasswordCookie(SECRET, PAGE, NOW + PAGE_PASSWORD_COOKIE_TTL_MS)
    const tampered = `${value.slice(0, -1)}${value.endsWith('a') ? 'b' : 'a'}`
    expect(verifyPagePasswordCookie(SECRET, PAGE, tampered, NOW)).toBe(false)
  })

  test('rejects a cookie signed with a different secret', () => {
    const value = signPagePasswordCookie('another-secret-32-bytes-long-xxxx', PAGE, NOW + 10_000)
    expect(verifyPagePasswordCookie(SECRET, PAGE, value, NOW)).toBe(false)
  })

  test('rejects missing / malformed values', () => {
    expect(verifyPagePasswordCookie(SECRET, PAGE, undefined, NOW)).toBe(false)
    expect(verifyPagePasswordCookie(SECRET, PAGE, '', NOW)).toBe(false)
    expect(verifyPagePasswordCookie(SECRET, PAGE, 'no-dot', NOW)).toBe(false)
  })
})
