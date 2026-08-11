import { describe, expect, test } from 'bun:test'

import { roleForEmail } from './role'

const ADMIN_LIST = ['admin@send.it', 'Owner@Send.It']

describe('roleForEmail (B-2 / REQ-AUTH-007 — config is the admin authority)', () => {
  test('derives admin from the configured email list regardless of naming case', () => {
    expect(roleForEmail('admin@send.it', ADMIN_LIST)).toBe('admin')
    expect(roleForEmail('  ADMIN@send.it  ', ADMIN_LIST)).toBe('admin')
    expect(roleForEmail('OWNER@send.it', ADMIN_LIST)).toBe('admin')
    expect(roleForEmail('owner@send.it', ADMIN_LIST)).toBe('admin')
  })

  test('demotes an email removed from the list (F-13 regression)', () => {
    // The stored row may still say 'admin'; the effective role must not.
    expect(roleForEmail('former-admin@send.it', ['admin@send.it'])).toBe('user')
    expect(roleForEmail('admin@send.it', [])).toBe('user')
  })

  test('defaults to a plain user for anything unlisted', () => {
    expect(roleForEmail('someone@example.com', ADMIN_LIST)).toBe('user')
  })
})
