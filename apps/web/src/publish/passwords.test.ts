import { describe, expect, test } from 'bun:test'

import { hashPagePassword, verifyPagePassword } from './passwords'

describe('page password hashes', () => {
  test('verify only accepts the generated password for the stored argon2 hash', async () => {
    const hash = await hashPagePassword('correct-password')

    expect(await verifyPagePassword('correct-password', hash)).toBe(true)
    expect(await verifyPagePassword('wrong-password', hash)).toBe(false)
    expect(await verifyPagePassword('correct-password', 'not-a-phc-hash')).toBe(false)
  })
})
