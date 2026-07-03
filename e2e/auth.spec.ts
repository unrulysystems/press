import { expect, test } from '@playwright/test'

import { localnetUsers } from '../apps/web/src/auth/localnetFixtures'

test('credential provider signs in a seeded localnet user', async ({ page, context, baseURL }) => {
  await page.goto('/login?next=/')
  await expect(page.getByRole('heading', { name: 'Sign in to keep reading.' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveCount(0)

  await page.getByLabel('Email').fill(localnetUsers.owner.email)
  await page.getByLabel('Password').fill('wrong-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('did not match')

  await page.getByLabel('Password').fill(localnetUsers.owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL('/')

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

test('signed-in reader can sign out from the masthead', async ({ page }) => {
  await page.goto('/login?next=/')
  await page.getByLabel('Email').fill(localnetUsers.owner.email)
  await page.getByLabel('Password').fill(localnetUsers.owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL('/')

  // Authenticated masthead exposes both identity and a working sign-out control.
  await expect(page.getByText(localnetUsers.owner.email)).toBeVisible()
  const signOut = page.getByRole('button', { name: 'Sign out' })
  await expect(signOut).toBeVisible()

  await signOut.click()

  // Sign-out reloads to "/"; the masthead now offers "Log in" and the session
  // API agrees the viewer is anonymous.
  await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)

  const whoami = await page.evaluate(async () => {
    const response = await fetch('/api/whoami')
    return await response.json()
  })
  expect(whoami.authenticated).toBe(false)
})
