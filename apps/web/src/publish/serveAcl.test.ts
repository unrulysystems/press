import { describe, expect, test } from 'bun:test'

import { deniedAclResponse, servedPageHeaders } from './serveAcl'

import type { AclDecision, AclDenyReason } from '@press/core'

function denied(reason: AclDenyReason): AclDecision {
  return { allowed: false, reason, resolvedVisibility: 'default' }
}

function request(accept: string): Request {
  return new Request('http://press.test/p/reports/index.html?view=1', {
    headers: { accept },
  })
}

function expectServedHeaders(response: Response): void {
  for (const [name, value] of Object.entries(servedPageHeaders)) {
    expect(response.headers.get(name)).toBe(value)
  }
}

describe('deniedAclResponse', () => {
  test('redirects anonymous HTML reads to login with next path', () => {
    const response = deniedAclResponse(request('text/html'), denied('authentication-required'))

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      '/login?next=%2Fp%2Freports%2Findex.html%3Fview%3D1',
    )
    expectServedHeaders(response)
  })

  test('returns 401 for anonymous non-HTML reads', () => {
    const response = deniedAclResponse(
      request('application/json'),
      denied('authentication-required'),
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBeNull()
    expectServedHeaders(response)
  })

  test.each(['domain-not-allowed', 'email-not-allowlisted', 'owner-required'] as const)(
    'returns 403 for authenticated forbidden reason %s',
    (reason) => {
      const response = deniedAclResponse(request('text/html'), denied(reason))

      expect(response.status).toBe(403)
      expectServedHeaders(response)
    },
  )

  test.each(['password-required', 'password-invalid'] as const)(
    'challenges Basic auth for %s',
    (reason) => {
      const response = deniedAclResponse(request('text/html'), denied(reason))

      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe('Basic realm="press"')
      expectServedHeaders(response)
    },
  )
})
