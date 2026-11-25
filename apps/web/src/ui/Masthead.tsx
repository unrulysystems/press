import { useEffect, useState } from 'react'

import type { MagazineViewer } from '@press/web/publish/indexes'

const SIGN_OUT_TIMEOUT_MS = 15_000

async function postSignOut(): Promise<boolean> {
  try {
    const response = await fetch('/api/auth/sign-out', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(SIGN_OUT_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

export function Masthead({
  viewer,
  loginNext,
}: {
  readonly viewer: MagazineViewer
  readonly loginNext: string
}) {
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  useEffect(() => {
    function handlePageShow(event: PageTransitionEvent): void {
      if (event.persisted) {
        setSigningOut(false)
      }
    }
    window.addEventListener('pageshow', handlePageShow)
    return () => {
      window.removeEventListener('pageshow', handlePageShow)
    }
  }, [])

  async function signOut() {
    setSignOutError(null)
    setSigningOut(true)
    // Reload to "/" after the session cookie is cleared so the masthead
    // re-derives from real session state rather than optimistic local state.
    const ok = await postSignOut()
    if (!ok) {
      setSigningOut(false)
      setSignOutError('Sign-out failed. Please try again.')
      return
    }
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
            {signOutError ? (
              <span className="press-account-error" role="alert">
                {signOutError}
              </span>
            ) : null}
          </span>
        ) : (
          <a
            className="press-meta press-nav-link"
            href={`/login?next=${encodeURIComponent(loginNext)}`}
          >
            Log in
          </a>
        )}
      </nav>
    </header>
  )
}
