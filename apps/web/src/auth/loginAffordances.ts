// What the /login identity gate shows, derived purely from enabled providers
// (REQ-AUTH-008). Credential auth is production-refused (INV-5), so the seeded
// account hint appears only when credential auth is enabled.
export type LoginAffordances = {
  readonly credentialForm: boolean
  readonly google: boolean
  readonly unavailable: boolean
  readonly seededHint: boolean
}

export function loginAffordances(input: {
  readonly credentialEnabled: boolean
  readonly googleEnabled: boolean
}): LoginAffordances {
  return {
    credentialForm: input.credentialEnabled,
    google: input.googleEnabled,
    unavailable: !input.credentialEnabled && !input.googleEnabled,
    seededHint: input.credentialEnabled,
  }
}
