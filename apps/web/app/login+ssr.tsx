import { useEffect, useState } from 'react'
import { useLoader } from 'one'

import { getDbConfig } from '@press/web/db/client'
import { loginAffordances, safeNext } from '@press/web/auth/loginAffordances'
import { localnetUsers } from '@press/web/auth/localnetFixtures'

import type { FormEvent } from 'react'
import type { LoaderProps } from 'one'

type LoginData = {
  readonly credentialEnabled: boolean
  readonly googleEnabled: boolean
  readonly next: string
  // Only present when credential auth is enabled (localnet). Never shipped in production,
  // where credential auth is boot-refused (INV-5) — so seeded credentials never leak.
  readonly seeded?: { readonly email: string; readonly password: string }
}

const AUTH_REQUEST_TIMEOUT_MS = 15_000

type SubmittingMode = 'idle' | 'credential' | 'google'

export function loader({ request }: LoaderProps): LoginData {
  const config = getDbConfig()
  const url = new URL(request?.url ?? config.baseUrl)
  const credentialEnabled = config.credentialAuthEnabled
  return {
    credentialEnabled,
    googleEnabled: Boolean(config.google),
    next: safeNext(url.searchParams.get('next')),
    ...(credentialEnabled
      ? { seeded: { email: localnetUsers.owner.email, password: localnetUsers.owner.password } }
      : {}),
  }
}

export function LoginPage() {
  const data = useLoader(loader)
  const view = loginAffordances(data)
  const [error, setError] = useState<string | null>(null)
  const [submittingMode, setSubmittingMode] = useState<SubmittingMode>('idle')
  const submitting = submittingMode !== 'idle'

  useEffect(() => {
    function handlePageShow(event: PageTransitionEvent): void {
      if (event.persisted) {
        setSubmittingMode('idle')
      }
    }
    window.addEventListener('pageshow', handlePageShow)
    return () => {
      window.removeEventListener('pageshow', handlePageShow)
    }
  }, [])

  // better-auth's /sign-in/social is POST-only and returns { url } to redirect to; a plain
  // GET link 404s. Since production refuses credential auth, this is the only way in.
  async function continueWithGoogle(): Promise<void> {
    setError(null)
    setSubmittingMode('google')
    try {
      const response = await fetch('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'google', callbackURL: data.next }),
        signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        setSubmittingMode('idle')
        setError('Could not start Google sign-in. Please try again.')
        return
      }
      const body = (await response.json()) as { readonly url?: string }
      if (!body.url) {
        setSubmittingMode('idle')
        setError('Google sign-in did not return a redirect URL.')
        return
      }
      window.location.assign(body.url)
    } catch {
      setSubmittingMode('idle')
      setError('Could not reach the sign-in service. Please try again.')
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmittingMode('credential')

    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '')
    const password = String(form.get('password') ?? '')
    try {
      const response = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, rememberMe: true }),
        signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
      })

      if (!response.ok) {
        setSubmittingMode('idle')
        if (response.status === 429) {
          setError('Too many sign-in attempts. Please wait a moment and try again.')
        } else if (response.status >= 500) {
          setError('Sign-in is temporarily unavailable. Please try again.')
        } else {
          setError('The email and password did not match a localnet account.')
        }
        return
      }

      window.location.assign(data.next)
    } catch {
      setSubmittingMode('idle')
      setError('Could not reach the sign-in service. Please try again.')
    }
  }

  return (
    <main className="press-page press-login-page" data-design-scope>
      <div className="press-shell press-login-shell">
        <header className="press-masthead" aria-label="press masthead">
          <a className="press-wordmark" href="/">
            press
          </a>
          <p className="press-meta">Reader sign in</p>
        </header>

        <section className="press-login-panel" data-spacing-sample aria-labelledby="login-title">
          <p className="press-kicker">Identity gate</p>
          <h1 id="login-title">Sign in to keep reading.</h1>
          <p className="press-login-copy">
            Access follows the page's visibility: public reports stay open, organization and private
            reports use your session.
          </p>

          {view.credentialForm ? (
            <form className="press-login-form" onSubmit={submit}>
              <label>
                <span>Email</span>
                <input name="email" type="email" autoComplete="email" required />
              </label>
              <label>
                <span>Password</span>
                <input name="password" type="password" autoComplete="current-password" required />
              </label>
              <button type="submit" disabled={submitting}>
                {submittingMode === 'credential' ? 'Signing in' : 'Sign in'}
              </button>
            </form>
          ) : null}

          {view.google ? (
            <button
              className="press-google-button"
              type="button"
              onClick={continueWithGoogle}
              disabled={submitting}
            >
              {submittingMode === 'google' ? 'Continuing with Google' : 'Continue with Google'}
            </button>
          ) : null}

          {error ? (
            <p className="press-form-error" role="alert">
              {error}
            </p>
          ) : null}

          {view.unavailable ? (
            <p className="press-login-notice" role="alert">
              Sign-in is unavailable — this instance has no identity provider configured. Contact
              the site operator.
            </p>
          ) : null}

          {view.seededHint && data.seeded ? (
            <p className="press-login-hint">
              Localnet seeded account — sign in with <strong>{data.seeded.email}</strong> and
              password <strong>{data.seeded.password}</strong>.
            </p>
          ) : null}

          <p className="press-login-guidance">
            Can&rsquo;t sign in? Access follows your organization account — ask whoever shared the
            report to grant your address or send you the page password.
          </p>
        </section>
      </div>
    </main>
  )
}
