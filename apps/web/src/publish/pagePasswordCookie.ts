import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

// Short-lived, page-scoped unlock cookie proving a viewer entered the page password
// on the branded gate (REQ-SRV-004). HMAC-signed with the server secret so it cannot
// be forged, carries its own expiry, and authorizes exactly one page.
export const PAGE_PASSWORD_COOKIE_TTL_MS = 60 * 60 * 1000 // 1 hour — short-lived

export function pagePasswordCookieName(pageId: string): string {
  return `press_pw_${pageId}`
}

// Read one cookie value from a `Cookie` header. The header is client-controlled, so a
// malformed percent-encoding must not throw (it would 500 the read and, since the unlock
// cookie is checked before Basic auth, block a request carrying valid Basic credentials).
// A bad value is treated as absent so the request falls back to Basic / the branded gate.
export function readCookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined
  }
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) {
      continue
    }
    if (part.slice(0, eq).trim() !== name) {
      continue
    }
    const raw = part.slice(eq + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      // Malformed percent-encoding in a client cookie: boundary validation, treat as absent.
      return undefined
    }
  }
  return undefined
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

// Stable digest of the page's current password hash so any reroll or overwrite
// invalidates already-issued unlock cookies immediately.
function passwordDigest(passwordHash: string | null): string {
  return createHash('sha256')
    .update(passwordHash ?? '')
    .digest('base64url')
}

// value = `${expiryMs}.${signature}`, signature = HMAC(secret, `${pageId}.${expiryMs}.${passwordDigest}`).
export function signPagePasswordCookie(
  secret: string,
  pageId: string,
  expiryMs: number,
  passwordHash: string | null,
): string {
  return `${expiryMs}.${sign(secret, `${pageId}.${expiryMs}.${passwordDigest(passwordHash)}`)}`
}

export function verifyPagePasswordCookie(
  secret: string,
  pageId: string,
  value: string | undefined,
  nowMs: number,
  passwordHash: string | null,
): boolean {
  if (!value) {
    return false
  }
  const dot = value.indexOf('.')
  if (dot === -1) {
    return false
  }
  const expiryMs = Number(value.slice(0, dot))
  const signature = value.slice(dot + 1)
  if (!Number.isSafeInteger(expiryMs) || expiryMs <= nowMs) {
    return false
  }
  const expected = sign(secret, `${pageId}.${expiryMs}.${passwordDigest(passwordHash)}`)
  const provided = Buffer.from(signature)
  const wanted = Buffer.from(expected)
  return provided.length === wanted.length && timingSafeEqual(provided, wanted)
}
