import type { UserRole } from '@press/core'

// Config is the source of truth for admin authority (REQ-AUTH-007): the
// persisted user.role column is a cache; every authorization use resolves the
// effective role from PRESS_ADMIN_EMAILS so removing an email demotes
// immediately — including for already-issued tokens and live sessions.
export function roleForEmail(email: string, adminEmails: readonly string[]): UserRole {
  const normalized = email.trim().toLowerCase()
  return adminEmails.some((entry) => entry.trim().toLowerCase() === normalized) ? 'admin' : 'user'
}
