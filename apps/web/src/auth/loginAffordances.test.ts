import { describe, expect, test } from 'bun:test'

import { loginAffordances } from './loginAffordances'

describe('loginAffordances (REQ-AUTH-008 / F5)', () => {
  test('both providers enabled: form + Google, seeded hint (credential ⇒ localnet)', () => {
    expect(loginAffordances({ credentialEnabled: true, googleEnabled: true })).toEqual({
      credentialForm: true,
      google: true,
      unavailable: false,
      seededHint: true,
    })
  })

  test('Google only: button, no form, no seeded hint', () => {
    expect(loginAffordances({ credentialEnabled: false, googleEnabled: true })).toEqual({
      credentialForm: false,
      google: true,
      unavailable: false,
      seededHint: false,
    })
  })

  test('credential only: form + seeded hint', () => {
    expect(loginAffordances({ credentialEnabled: true, googleEnabled: false })).toEqual({
      credentialForm: true,
      google: false,
      unavailable: false,
      seededHint: true,
    })
  })

  test('neither provider: explicit unavailable state (never a copy-only dead-end)', () => {
    expect(loginAffordances({ credentialEnabled: false, googleEnabled: false })).toEqual({
      credentialForm: false,
      google: false,
      unavailable: true,
      seededHint: false,
    })
  })

  test('invariant: the page always presents something actionable or an explicit unavailable notice', () => {
    for (const credentialEnabled of [true, false]) {
      for (const googleEnabled of [true, false]) {
        const view = loginAffordances({ credentialEnabled, googleEnabled })
        expect(view.credentialForm || view.google || view.unavailable).toBe(true)
      }
    }
  })
})
