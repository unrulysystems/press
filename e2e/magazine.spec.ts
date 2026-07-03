import { expect, test } from '@playwright/test'

import { localnetUsers } from '../apps/web/src/auth/localnetFixtures'

const publicNewest = 'Agent Margin Review'
const publicOlder = 'Pricing Scenario Map'
const defaultTitle = 'Latency Budget Audit'
const passwordTitle = 'Checkout Cohort Notes'
const privateTitle = 'Board Prep Index'
const publicSecondCollection = 'Partner Update Brief'

async function signIn(page: import('@playwright/test').Page, key: keyof typeof localnetUsers) {
  await page.goto('/login?next=/')
  await page.getByLabel('Email').fill(localnetUsers[key].email)
  await page.getByLabel('Password').fill(localnetUsers[key].password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL('/')
}

async function titles(page: import('@playwright/test').Page): Promise<string[]> {
  return await page.getByRole('article').locator('h2').allTextContents()
}

function expectRelativeOrder(feedTitles: readonly string[], expected: readonly string[]) {
  const positions = expected.map((title) => feedTitles.indexOf(title))
  expect(positions, `expected titles present: ${expected.join(', ')}`).not.toContain(-1)
  expect(positions).toEqual([...positions].toSorted((left, right) => left - right))
}

test('anonymous feed lists only public pages newest-first without leaking gated titles', async ({
  page,
}) => {
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)

  await expect(page.getByRole('heading', { name: 'Reports for close reading.' })).toBeVisible()
  const feedTitles = await titles(page)
  expect(feedTitles).toEqual(
    expect.arrayContaining([publicNewest, publicSecondCollection, publicOlder]),
  )
  expectRelativeOrder(feedTitles, [publicNewest, publicSecondCollection, publicOlder])
  await expect(page.getByText(defaultTitle)).toHaveCount(0)
  await expect(page.getByText(passwordTitle)).toHaveCount(0)
  await expect(page.getByText(privateTitle)).toHaveCount(0)
})

test('domain user feed lists default and password pages with lock affordance', async ({ page }) => {
  await signIn(page, 'secondUser')

  const feedTitles = await titles(page)
  expectRelativeOrder(feedTitles, [
    publicNewest,
    defaultTitle,
    passwordTitle,
    publicSecondCollection,
    publicOlder,
  ])
  await expect(page.getByRole('article').filter({ hasText: passwordTitle })).toContainText('Locked')
  await expect(page.getByText(privateTitle)).toHaveCount(0)
})

test('owner feed includes their private pages after public, default, and password entries', async ({
  page,
}) => {
  await signIn(page, 'owner')

  expectRelativeOrder(await titles(page), [
    publicNewest,
    defaultTitle,
    passwordTitle,
    publicSecondCollection,
    privateTitle,
    publicOlder,
  ])
})

test('collection page applies the same ACL filtering and 404 rules', async ({ page }) => {
  let response = await page.goto('/c/market-notes')
  expect(response?.status()).toBe(200)
  expect(await titles(page)).toEqual([publicNewest, publicOlder])
  await expect(page.getByText(passwordTitle)).toHaveCount(0)

  await signIn(page, 'secondUser')
  response = await page.goto('/c/market-notes')
  expect(response?.status()).toBe(200)
  expect(await titles(page)).toEqual([publicNewest, passwordTitle, publicOlder])
  await expect(page.getByRole('article').filter({ hasText: passwordTitle })).toContainText('Locked')

  response = await page.goto('/c/not-a-real-collection')
  expect(response?.status()).toBe(404)

  const anonymous = await page.context().browser()?.newPage()
  if (!anonymous) {
    throw new Error('browser missing for anonymous collection probe')
  }
  response = await anonymous.goto('/c/private-docket')
  expect(response?.status()).toBe(404)
  await anonymous.close()
})
