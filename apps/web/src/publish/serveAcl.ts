import type {
  AclDecision,
  AclViewer,
  AuthenticatedViewer,
  BasicPasswordVerification,
} from '@press/core'

export const servedPageHeaders = {
  'Content-Security-Policy': 'sandbox allow-scripts allow-popups',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
} as const

export function servedPageResponse(body: BodyInit | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  for (const [name, value] of Object.entries(servedPageHeaders)) {
    headers.set(name, value)
  }
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/html; charset=utf-8')
  }
  return new Response(body, { ...init, headers })
}

export function viewerFromChannels(input: {
  readonly authenticated?: AuthenticatedViewer | null
  readonly basicPassword?: BasicPasswordVerification | undefined
}): AclViewer {
  const basicPassword = input.basicPassword ? { basicPassword: input.basicPassword } : {}
  if (input.authenticated) {
    return { ...input.authenticated, ...basicPassword }
  }
  return { kind: 'anonymous', ...basicPassword }
}

function acceptsHtml(request: Request): boolean {
  return (request.headers.get('accept') ?? '').toLowerCase().includes('text/html')
}

function redirectToLogin(request: Request): Response {
  const url = new URL(request.url)
  const next = `${url.pathname}${url.search}`
  const login = new URL('/login', url)
  login.searchParams.set('next', next)
  return servedPageResponse(null, {
    status: 302,
    headers: { location: `${login.pathname}${login.search}` },
  })
}

export function deniedAclResponse(request: Request, decision: AclDecision): Response {
  if (decision.allowed) {
    throw new Error('deniedAclResponse requires a denied ACL decision')
  }

  switch (decision.reason) {
    case 'authentication-required':
      return acceptsHtml(request)
        ? redirectToLogin(request)
        : servedPageResponse('authentication required', { status: 401 })
    case 'domain-not-allowed':
    case 'email-not-allowlisted':
    case 'owner-required':
      return servedPageResponse('forbidden', { status: 403 })
    case 'password-required':
    case 'password-invalid':
      return servedPageResponse('password required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="press"' },
      })
    default: {
      const exhaustive: never = decision.reason
      throw new Error(`unhandled ACL deny reason: ${exhaustive}`)
    }
  }
}
