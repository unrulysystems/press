import type { AuthenticatedViewer } from '@press/core'

import { isUserActivelyBanned } from './apiTokens'
import { roleForEmail } from './role'

export type SessionUserRow = {
  readonly id: string
  readonly email: string
  readonly banned: boolean
  readonly banExpires: Date | null
}

// The single construction point for a browser-session viewer (serving + indexes).
// A banned user's live session must not authorize reads (F-29): the bearer-token
// path already rejects bans in verifyApiToken, and the session path must match.
// The effective role re-derives from PRESS_ADMIN_EMAILS at use-time (REQ-AUTH-007);
// the persisted role column is only a cache and is never read here.
export function authenticatedViewerForSession(
  row: SessionUserRow,
  adminEmails: readonly string[],
): AuthenticatedViewer | null {
  if (isUserActivelyBanned({ banned: row.banned, banExpires: row.banExpires })) {
    return null
  }
  return {
    kind: 'authenticated',
    userId: row.id,
    email: row.email,
    role: roleForEmail(row.email, adminEmails),
  }
}
