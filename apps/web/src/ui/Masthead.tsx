import { useState } from 'react'

import type { MagazineViewer } from '@press/web/publish/indexes'

// Shared magazine masthead for the index and collection feeds. Both surfaces
// render an identical wordmark + account nav; keeping it in one place means the
// sign-out affordance can never drift between them.

async function postSignOut(): Promise<void> {
  await fetch('/api/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
}

export function Masthead({
  viewer,
  loginNext,
}: {
  readonly viewer: MagazineViewer
  // Raw path (not URL-encoded) so the login page's safeNext startsWith('/')
  // check accepts it; encoding "/" would fail that guard and drop the redirect.
  readonly loginNext: string
}) {
  const [signingOut, setSigningOut] = useState(false)

  async function signOut() {
    setSigningOut(true)
    // Reload to "/" after the session cookie is cleared so the masthead
    // re-derives from real session state rather than optimistic local state.
    await postSignOut()
    window.location.assign('/')
  }

  return (
    <header className="press-masthead" aria-label="press masthead">
      <a className="press-wordmark" href="/">
        press
      </a>
      <nav className="press-nav" aria-label="Account">
        {viewer.authenticated ? (
          <span className="press-account">
            <span className="press-meta">{viewer.email}</span>
            <button
              className="press-nav-button"
              type="button"
              onClick={signOut}
              disabled={signingOut}
            >
              {signingOut ? 'Signing out' : 'Sign out'}
            </button>
          </span>
        ) : (
          <a className="press-meta press-nav-link" href={`/login?next=${loginNext}`}>
            Log in
          </a>
        )}
      </nav>
    </header>
  )
}
