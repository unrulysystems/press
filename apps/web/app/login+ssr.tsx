import { useState } from 'react'
import { useLoader } from 'one'

import { dbConfig } from '@press/web/db/client'

import type { FormEvent } from 'react'
import type { LoaderProps } from 'one'

type LoginData = {
  readonly credentialEnabled: boolean
  readonly googleEnabled: boolean
  readonly next: string
}

function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/'
  }
  return raw
}

export function loader({ request }: LoaderProps): LoginData {
  const url = new URL(request?.url ?? dbConfig.baseUrl)
  return {
    credentialEnabled: dbConfig.credentialAuthEnabled,
    googleEnabled: Boolean(dbConfig.googleClientId && dbConfig.googleClientSecret),
    next: safeNext(url.searchParams.get('next')),
  }
}

export function LoginPage() {
  const data = useLoader(loader)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const googleHref = `/api/auth/sign-in/social?provider=google&callbackURL=${encodeURIComponent(
    data.next,
  )}`

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '')
    const password = String(form.get('password') ?? '')
    const response = await fetch('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, rememberMe: true }),
    })

    if (!response.ok) {
      setSubmitting(false)
      setError('The email and password did not match a localnet account.')
      return
    }

    window.location.assign(data.next)
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

          {data.credentialEnabled ? (
            <form className="press-login-form" onSubmit={submit}>
              <label>
                <span>Email</span>
                <input name="email" type="email" autoComplete="email" required />
              </label>
              <label>
                <span>Password</span>
                <input name="password" type="password" autoComplete="current-password" required />
              </label>
              {error ? (
                <p className="press-form-error" role="alert">
                  {error}
                </p>
              ) : null}
              <button type="submit" disabled={submitting}>
                {submitting ? 'Signing in' : 'Sign in'}
              </button>
            </form>
          ) : null}

          {data.googleEnabled ? (
            <a className="press-google-button" href={googleHref}>
              Continue with Google
            </a>
          ) : null}
        </section>
      </div>
    </main>
  )
}
