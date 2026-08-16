import { describe, expect, test } from 'bun:test'

import { authenticatedViewerForSession } from './sessionViewer'

import type { SessionUserRow } from './sessionViewer'

const ADMIN: readonly string[] = ['admin@send.it']

function row(overrides: Partial<SessionUserRow> = {}): SessionUserRow {
  return {
    id: 'user-1',
    email: 'owner@send.it',
    banned: false,
    banExpires: null,
    ...overrides,
  }
}

describe('authenticatedViewerForSession (F-29)', () => {
  test('returns an authenticated viewer for an unbanned user', () => {
    expect(authenticatedViewerForSession(row(), ADMIN)).toEqual({
      kind: 'authenticated',
      userId: 'user-1',
      email: 'owner@send.it',
      role: 'user',
    })
  })

  test('rejects an actively banned user (session reads must match token reads)', () => {
    expect(authenticatedViewerForSession(row({ banned: true, banExpires: null }), ADMIN)).toBeNull()
    expect(
      authenticatedViewerForSession(
        row({ banned: true, banExpires: new Date(Date.now() + 60_000) }),
        ADMIN,
      ),
    ).toBeNull()
  })

  test('accepts an expired ban', () => {
    const viewer = authenticatedViewerForSession(
      row({ banned: true, banExpires: new Date(Date.now() - 1_000) }),
      ADMIN,
    )
    expect(viewer).not.toBeNull()
    expect(viewer?.kind).toBe('authenticated')
  })

  test('derives the effective role from PRESS_ADMIN_EMAILS at use-time', () => {
    const admin = authenticatedViewerForSession(
      row({ id: 'user-admin', email: 'admin@send.it' }),
      ADMIN,
    )
    expect(admin?.role).toBe('admin')

    const demoted = authenticatedViewerForSession(
      row({ id: 'user-admin', email: 'admin@send.it' }),
      [],
    )
    expect(demoted?.role).toBe('user')
  })
})
