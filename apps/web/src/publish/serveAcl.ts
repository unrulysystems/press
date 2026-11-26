import { COLLECTION_DEFAULT_VISIBILITIES } from '@press/core'

import type {
  AclDecision,
  AclViewer,
  AuthenticatedViewer,
  BasicPasswordVerification,
  CollectionDefaultVisibility,
} from '@press/core'

import { escapeHtml } from '../http/responses'

export function assertCollectionDefaultVisibility(value: string): CollectionDefaultVisibility {
  if ((COLLECTION_DEFAULT_VISIBILITIES as readonly string[]).includes(value)) {
    return value as CollectionDefaultVisibility
  }
  throw new Error(`unexpected collection default visibility in database: ${value}`)
}

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

export function acceptsHtml(request: Request): boolean {
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

const GATE_PAGE_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  min-height: 100vh;
  background: #faf9f7;
  color: #1a1a1a;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  line-height: 1.5;
  display: flex;
  justify-content: center;
}
.gate { width: 100%; max-width: 33rem; padding: clamp(1.5rem, 5vw, 4rem); }
.masthead {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 1rem; border-bottom: 1px solid rgba(0,0,0,0.12);
  padding-bottom: 1rem; margin-bottom: clamp(2rem, 8vw, 4rem);
}
.wordmark {
  font-family: Newsreader, Georgia, Cambria, Times New Roman, serif;
  font-size: 1.6rem; font-weight: 600; letter-spacing: -0.01em;
}
.meta { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.6; }
.kicker { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.1em; opacity: 0.55; margin: 0 0 0.75rem; }
h1 {
  font-family: Newsreader, Georgia, Cambria, Times New Roman, serif;
  font-weight: 600; font-size: clamp(1.9rem, 7vw, 2.9rem);
  line-height: 1.12; letter-spacing: -0.02em; margin: 0 0 1rem; overflow-wrap: break-word;
}
.copy { max-width: 34ch; opacity: 0.75; margin: 0 0 2rem; }
form { display: flex; flex-direction: column; gap: 0.75rem; max-width: 22rem; }
label { display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.85rem; opacity: 0.75; }
input {
  width: 100%; padding: 0.7rem 0.85rem; font-size: 1rem;
  border: 1px solid rgba(0,0,0,0.28); border-radius: 2px;
  background: #fff; color: inherit;
}
input:focus-visible { outline: 2px solid #1a1a1a; outline-offset: 1px; }
button {
  align-self: flex-start; margin-top: 0.5rem; padding: 0.7rem 1.4rem;
  font: inherit; font-weight: 600; color: #faf9f7; background: #1a1a1a;
  border: 0; border-radius: 2px; cursor: pointer;
}
.error { color: #a01919; font-size: 0.9rem; margin: 0; }
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #ededed; }
  .masthead { border-color: rgba(255,255,255,0.14); }
  input { background: #1b1b1b; border-color: rgba(255,255,255,0.28); }
  input:focus-visible { outline-color: #ededed; }
  button { color: #111; background: #ededed; }
  .error { color: #ff8a8a; }
}
`.trim()

// Branded password-entry page (REQ-SRV-004). Never contains the report body; title and
// error are HTML-escaped because titles originate from the report author.
export function renderPasswordGatePage(input: {
  readonly title: string
  readonly actionPath: string
  readonly error?: string
}): string {
  const title = escapeHtml(input.title)
  const action = escapeHtml(input.actionPath)
  const error = input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — password required</title>
<style>${GATE_PAGE_STYLE}</style>
</head>
<body>
<main class="gate">
<header class="masthead"><span class="wordmark">press</span><span class="meta">Password required</span></header>
<section class="panel">
<p class="kicker">Protected report</p>
<h1>${title}</h1>
<p class="copy">This report is password-protected. Enter the password you were given to read it.</p>
<form method="post" action="${action}">
<label><span>Password</span><input type="password" name="password" autocomplete="current-password" autofocus required></label>
${error}
<button type="submit">Unlock</button>
</form>
</section>
</main>
</body>
</html>`
}

// Strict form-capable CSP for press's own unlock chrome (REQ-SRV-004): no scripts,
// inline styles only, same-origin form submission.
export const passwordGateHeaders = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'content-type': 'text/html; charset=utf-8',
} as const

export function passwordGateResponse(input: {
  readonly title: string
  readonly actionPath: string
  readonly error?: string
  readonly status: number
}): Response {
  return new Response(
    renderPasswordGatePage({
      title: input.title,
      actionPath: input.actionPath,
      ...(input.error ? { error: input.error } : {}),
    }),
    { status: input.status, headers: { ...passwordGateHeaders } },
  )
}
