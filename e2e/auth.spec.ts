import { expect, test } from '@playwright/test'

import { localnetUsers } from '../apps/web/src/auth/localnetFixtures'

test('credential provider signs in a seeded localnet user', async ({ page, context, baseURL }) => {
  await page.goto('/login?next=/')
  await expect(page.getByRole('heading', { name: 'Sign in to keep reading.' })).toBeVisible()
  // Google sign-in is a POST-driven <button> (not a GET <a>); it never shows in credential mode.
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0)

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

test('localnet identity gate shows the seeded account hint and reader guidance (F5 / REQ-AUTH-008)', async ({
  page,
}) => {
  await page.goto('/login?next=/')
  await expect(page.getByRole('heading', { name: 'Sign in to keep reading.' })).toBeVisible()

  // Credential form is present on localnet (the enabled provider affordance).
  await expect(page.getByLabel('Email')).toBeVisible()
  await expect(page.getByLabel('Password')).toBeVisible()

  // Seeded account hint answers the dogfood F5 complaint ("what were the passwords?").
  await expect(page.getByText(localnetUsers.owner.email)).toBeVisible()
  await expect(page.getByText(localnetUsers.owner.password)).toBeVisible()

  // Reader guidance for someone who cannot sign in — the gate is never a dead-end.
  await expect(page.getByText(/access follows your organization account/i)).toBeVisible()
})

test('admin-plugin routes are unreachable after the plugin is dropped (B-3 / F-14)', async ({
  page,
}) => {
  const probes = [
    { method: 'GET', path: '/api/auth/admin/list-users' },
    { method: 'POST', path: '/api/auth/admin/set-role' },
  ] as const

  // Anonymous sessions must 404 too — the route no longer exists at all.
  for (const probe of probes) {
    // oxlint-disable-next-line no-await-in-loop -- each anonymous probe is its own navigation
    await page.goto('/login?next=/')
    // oxlint-disable-next-line no-await-in-loop -- probe result asserted per iteration
    const anonymous = await page.evaluate(async (entry) => {
      const result = await fetch(entry.path, { method: entry.method })
      return { status: result.status }
    }, probe)
    expect(anonymous.status, `anonymous ${probe.method} ${probe.path}`).toBe(404)
  }

  // An admin session — which previously reached these routes (200) — also 404s.
  await page.goto('/login?next=/')
  await page.getByLabel('Email').fill(localnetUsers.admin.email)
  await page.getByLabel('Password').fill(localnetUsers.admin.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL('/')

  for (const probe of probes) {
    // oxlint-disable-next-line no-await-in-loop -- each admin probe is its own request
    const response = await page.evaluate(async (entry) => {
      const result = await fetch(entry.path, { method: entry.method })
      return { status: result.status }
    }, probe)
    expect(response.status, `${probe.method} ${probe.path}`).toBe(404)
  }
})
