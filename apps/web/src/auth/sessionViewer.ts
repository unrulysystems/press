import { eq } from 'drizzle-orm'

import type { AuthenticatedViewer } from '@press/core'

import { user } from '../db/schema'
import { isUserActivelyBanned } from './apiTokens'
import { roleForEmail } from './role'

import type { PressDb } from '../db/client'

export type SessionUserRow = {
  readonly id: string
  readonly email: string
  readonly banned: boolean
  readonly banExpires: Date | null
}

// Single construction point for a browser-session viewer. Enforces active-ban
// rejection and re-derives the effective admin role from PRESS_ADMIN_EMAILS
// (REQ-AUTH-007) instead of trusting the cached user.role column.
export function authenticatedViewerForSession(
  row: SessionUserRow,
  adminEmails: readonly string[],
  now = new Date(),
): AuthenticatedViewer | null {
  if (isUserActivelyBanned({ banned: row.banned, banExpires: row.banExpires }, now)) {
    return null
  }
  return {
    kind: 'authenticated',
    userId: row.id,
    email: row.email,
    role: roleForEmail(row.email, adminEmails),
  }
}

export async function loadActiveViewerForUserId(
  db: PressDb,
  userId: string,
  adminEmails: readonly string[],
  now = new Date(),
): Promise<AuthenticatedViewer | null> {
  const dbUser = await db.query.user.findFirst({
    where: eq(user.id, userId),
  })
  return dbUser ? authenticatedViewerForSession(dbUser, adminEmails, now) : null
}
