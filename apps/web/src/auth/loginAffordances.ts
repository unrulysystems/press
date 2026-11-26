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

const SAFE_NEXT_SENTINEL_ORIGIN = 'https://press.invalid'

export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) {
    return '/'
  }
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      return '/'
    }
  }
  try {
    const parsed = new URL(raw, SAFE_NEXT_SENTINEL_ORIGIN)
    if (
      parsed.origin !== SAFE_NEXT_SENTINEL_ORIGIN ||
      !parsed.pathname.startsWith('/') ||
      parsed.pathname.startsWith('//')
    ) {
      return '/'
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return '/'
  }
}
