import { describe, expect, test } from 'bun:test'

import {
  PAGE_PASSWORD_COOKIE_TTL_MS,
  pagePasswordCookieName,
  readCookieValue,
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

describe('readCookieValue (boundary-tolerant cookie parsing / F1 review)', () => {
  test('returns the named cookie value', () => {
    expect(readCookieValue('a=1; press_pw_x=abc.def; b=2', 'press_pw_x')).toBe('abc.def')
  })

  test('returns undefined when the cookie is absent or the header is empty', () => {
    expect(readCookieValue('a=1; b=2', 'press_pw_x')).toBeUndefined()
    expect(readCookieValue(null, 'press_pw_x')).toBeUndefined()
    expect(readCookieValue('', 'press_pw_x')).toBeUndefined()
  })

  test('ignores a malformed percent-encoded value instead of throwing (client-controlled)', () => {
    // decodeURIComponent('%E0%A4%A') throws URIError; a bad cookie must not 500 the
    // request nor block a fallback to Basic auth / the branded gate.
    expect(() => readCookieValue('press_pw_x=%E0%A4%A', 'press_pw_x')).not.toThrow()
    expect(readCookieValue('press_pw_x=%E0%A4%A', 'press_pw_x')).toBeUndefined()
  })

  test('decodes a percent-encoded value', () => {
    expect(readCookieValue('press_pw_x=a%2Eb', 'press_pw_x')).toBe('a.b')
  })
})
