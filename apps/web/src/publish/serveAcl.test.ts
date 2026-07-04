import { describe, expect, test } from 'bun:test'

import {
  deniedAclResponse,
  passwordGateResponse,
  renderPasswordGatePage,
  servedPageHeaders,
  viewerFromChannels,
} from './serveAcl'

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

describe('viewerFromChannels', () => {
  const authenticated = {
    kind: 'authenticated',
    userId: 'user-second',
    email: 'second@send.it',
    role: 'user',
  } as const

  test('keeps Basic verification alongside an authenticated session', () => {
    expect(
      viewerFromChannels({
        authenticated,
        basicPassword: { verified: true },
      }),
    ).toEqual({
      ...authenticated,
      basicPassword: { verified: true },
    })
  })

  test('keeps Basic verification for anonymous requests without inventing a session', () => {
    expect(viewerFromChannels({ basicPassword: { verified: false } })).toEqual({
      kind: 'anonymous',
      basicPassword: { verified: false },
    })
  })
})

describe('renderPasswordGatePage (REQ-SRV-004 / F1)', () => {
  test('renders a branded post-to-unlock form for the page', () => {
    const html = renderPasswordGatePage({
      title: 'Quarterly Numbers',
      actionPath: '/p/reports/q3.html',
    })
    expect(html).toContain('<form')
    expect(html).toContain('method="post"')
    expect(html).toContain('action="/p/reports/q3.html"')
    expect(html).toContain('name="password"')
    expect(html).toContain('type="password"')
    expect(html).toContain('Quarterly Numbers')
    expect(html).toContain('press') // masthead wordmark
  })

  test('never leaks the report body — it only has the gate chrome', () => {
    const html = renderPasswordGatePage({ title: 'Secret', actionPath: '/p/c/f.html' })
    // the renderer has no access to the report body by construction
    expect(html).not.toContain('<article')
  })

  test('HTML-escapes the title and error (XSS: title comes from the report author)', () => {
    const html = renderPasswordGatePage({
      title: '<script>alert(1)</script>',
      actionPath: '/p/c/f.html',
      error: '<img src=x onerror=alert(2)>',
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x onerror=alert(2)>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('shows the error message when provided', () => {
    const html = renderPasswordGatePage({
      title: 'X',
      actionPath: '/p/c/f.html',
      error: 'Incorrect password.',
    })
    expect(html).toContain('Incorrect password.')
  })
})

describe('passwordGateResponse CSP (REQ-SRV-004 / F1)', () => {
  test('allows the unlock form to submit to self but blocks scripts', async () => {
    const response = passwordGateResponse({
      title: 'X',
      actionPath: '/p/c/f.html',
      status: 200,
    })
    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("form-action 'self'")
    expect(csp).not.toContain('allow-scripts')
    expect(csp).toContain("default-src 'none'")
    expect(response.headers.get('cache-control')).toBe('no-store')
    // the body carries no report content, only the gate form
    expect(await response.text()).toContain('name="password"')
  })

  test('a wrong-password gate is a 401 with the error', async () => {
    const response = passwordGateResponse({
      title: 'X',
      actionPath: '/p/c/f.html',
      error: 'Incorrect password.',
      status: 401,
    })
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('Incorrect password.')
  })
})
