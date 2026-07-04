// What the /login identity gate shows, derived purely from which providers are enabled
// (REQ-AUTH-008 / F5). The gate must never be a copy-only dead-end: when no provider is
// enabled it presents an explicit unavailable notice instead of an empty panel. Credential
// auth is production-refused (INV-5), so it only ever runs on localnet — hence the seeded
// account hint is gated on it.
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
