import { expect, test } from '@playwright/test'

import { localnetUsers } from '../apps/web/src/auth/localnetFixtures'

test('credential provider signs in a seeded localnet user', async ({ page, context, baseURL }) => {
  await page.goto('/')

  const signInResult = await page.evaluate(
    async ({ email, password }) => {
      const response = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password,
          rememberMe: true,
        }),
      })

      return {
        ok: response.ok,
        status: response.status,
        body: await response.json(),
      }
    },
    {
      email: localnetUsers.owner.email,
      password: localnetUsers.owner.password,
    },
  )

  expect(signInResult.status).toBe(200)
  expect(signInResult.ok).toBe(true)
  expect(signInResult.body.user.email).toBe(localnetUsers.owner.email)

  const cookies = await context.cookies(baseURL)
  const sessionCookie = cookies.find((cookie) => cookie.name.toLowerCase().includes('session'))
  expect(sessionCookie, 'Better Auth session cookie should be set').toBeDefined()
  expect(sessionCookie?.httpOnly).toBe(true)
  expect(sessionCookie?.sameSite).toBe('Lax')

  const whoami = await page.evaluate(async () => {
    const response = await fetch('/api/whoami')
    return {
      status: response.status,
      body: await response.json(),
    }
  })

  expect(whoami).toEqual({
    status: 200,
    body: {
      authenticated: true,
      user: {
        id: expect.any(String),
        email: localnetUsers.owner.email,
        role: 'user',
      },
    },
  })
})
