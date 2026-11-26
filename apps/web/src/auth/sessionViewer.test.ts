import { describe, expect, test } from 'bun:test'

import { authenticatedViewerForSession } from './sessionViewer'

import type { SessionUserRow } from './sessionViewer'

const ADMIN: readonly string[] = ['admin@send.it']
const NOW = new Date('2026-06-01T12:00:00.000Z')

function row(overrides: Partial<SessionUserRow> = {}): SessionUserRow {
  return {
    id: 'user-1',
    email: 'owner@send.it',
    banned: false,
    banExpires: null,
    ...overrides,
  }
}

describe('authenticatedViewerForSession', () => {
  test('returns an authenticated viewer for an unbanned user', () => {
    expect(authenticatedViewerForSession(row(), ADMIN, NOW)).toEqual({
      kind: 'authenticated',
      userId: 'user-1',
      email: 'owner@send.it',
      role: 'user',
    })
  })

  test('rejects an actively banned user', () => {
    expect(
      authenticatedViewerForSession(row({ banned: true, banExpires: null }), ADMIN, NOW),
    ).toBeNull()
    expect(
      authenticatedViewerForSession(
        row({ banned: true, banExpires: new Date('2026-06-01T12:01:00.000Z') }),
        ADMIN,
        NOW,
      ),
    ).toBeNull()
  })

  test('accepts an expired ban at or past the expiry boundary', () => {
    const expired = authenticatedViewerForSession(
      row({ banned: true, banExpires: new Date('2026-06-01T11:59:59.000Z') }),
      ADMIN,
      NOW,
    )
    expect(expired).not.toBeNull()
    expect(expired?.kind).toBe('authenticated')

    const exactBoundary = authenticatedViewerForSession(
      row({ banned: true, banExpires: NOW }),
      ADMIN,
      NOW,
    )
    expect(exactBoundary).not.toBeNull()
  })

  test('derives the effective role from PRESS_ADMIN_EMAILS at use-time', () => {
    const admin = authenticatedViewerForSession(
      row({ id: 'user-admin', email: 'admin@send.it' }),
      ADMIN,
      NOW,
    )
    expect(admin?.role).toBe('admin')

    const demoted = authenticatedViewerForSession(
      row({ id: 'user-admin', email: 'admin@send.it' }),
      [],
      NOW,
    )
    expect(demoted?.role).toBe('user')
  })
})
