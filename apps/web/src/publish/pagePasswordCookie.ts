import { createHmac, timingSafeEqual } from 'node:crypto'

// A short-lived, page-scoped unlock cookie proves a viewer entered the correct
// password on the branded gate (REQ-SRV-004 / F1). It is HMAC-signed with the
// server secret so it cannot be forged, carries its own expiry, and authorizes
// exactly one page. It replaces re-sending Basic credentials on every request for
// browser readers, while the Basic channel stays available for programmatic clients.
export const PAGE_PASSWORD_COOKIE_TTL_MS = 60 * 60 * 1000 // 1 hour — short-lived

export function pagePasswordCookieName(pageId: string): string {
  return `press_pw_${pageId}`
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

// value = `${expiryMs}.${signature}`, signature = HMAC(secret, `${pageId}.${expiryMs}`).
export function signPagePasswordCookie(secret: string, pageId: string, expiryMs: number): string {
  return `${expiryMs}.${sign(secret, `${pageId}.${expiryMs}`)}`
}

export function verifyPagePasswordCookie(
  secret: string,
  pageId: string,
  value: string | undefined,
  nowMs: number,
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
  const expected = sign(secret, `${pageId}.${expiryMs}`)
  const provided = Buffer.from(signature)
  const wanted = Buffer.from(expected)
  return provided.length === wanted.length && timingSafeEqual(provided, wanted)
}
