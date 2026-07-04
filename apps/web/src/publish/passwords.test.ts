import { describe, expect, test } from 'bun:test'

import {
  MIN_PAGE_PASSWORD_LENGTH,
  hashPagePassword,
  isStrongPagePassword,
  verifyPagePassword,
} from './passwords'

describe('page password hashes', () => {
  test('verify only accepts the generated password for the stored argon2 hash', async () => {
    const hash = await hashPagePassword('correct-password')

    expect(await verifyPagePassword('correct-password', hash)).toBe(true)
    expect(await verifyPagePassword('wrong-password', hash)).toBe(false)
    expect(await verifyPagePassword('correct-password', 'not-a-phc-hash')).toBe(false)
  })
})

describe('isStrongPagePassword (REQ-PUB-005 / F3)', () => {
  test('rejects passwords shorter than the minimum', () => {
    expect(MIN_PAGE_PASSWORD_LENGTH).toBe(8)
    expect(isStrongPagePassword('short')).toBe(false)
    expect(isStrongPagePassword('1234567')).toBe(false)
    expect(isStrongPagePassword('')).toBe(false)
  })

  test('accepts passwords at or above the minimum length', () => {
    expect(isStrongPagePassword('12345678')).toBe(true)
    expect(isStrongPagePassword('liberty-1776')).toBe(true)
  })

  test('does not count surrounding whitespace toward the minimum', () => {
    expect(isStrongPagePassword('  a  ')).toBe(false)
  })
})
