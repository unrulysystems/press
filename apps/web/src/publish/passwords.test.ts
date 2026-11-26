import { describe, expect, test } from 'bun:test'

import { hashPagePassword, isStrongPagePassword, verifyPagePassword } from './passwords'

describe('page password hashes', () => {
  test('verify only accepts the generated password for the stored argon2 hash', async () => {
    const hash = await hashPagePassword('correct-password')

    expect(await verifyPagePassword('correct-password', hash)).toBe(true)
    expect(await verifyPagePassword('wrong-password', hash)).toBe(false)
    expect(await verifyPagePassword('correct-password', 'not-a-phc-hash')).toBe(false)
  })
})

describe('isStrongPagePassword', () => {
  test('rejects passwords shorter than 8 characters', () => {
    expect(isStrongPagePassword('short')).toBe(false)
    expect(isStrongPagePassword('1234567')).toBe(false)
    expect(isStrongPagePassword('')).toBe(false)
  })

  test('accepts passwords at or above 8 characters', () => {
    expect(isStrongPagePassword('12345678')).toBe(true)
    expect(isStrongPagePassword('liberty-1776')).toBe(true)
  })

  test('does not count surrounding whitespace toward the minimum', () => {
    expect(isStrongPagePassword('  123456  ')).toBe(false)
    expect(isStrongPagePassword('  12345678  ')).toBe(true)
  })
})
