import { expect, test, type Locator, type Page } from '@playwright/test'

import { localnetUsers } from '../apps/web/src/auth/localnetFixtures'

const publicNewest = 'Agent Margin Review'
const publicOlder = 'Pricing Scenario Map'
const defaultTitle = 'Latency Budget Audit'
const passwordTitle = 'Checkout Cohort Notes'
const privateTitle = 'Board Prep Index'
const publicSecondCollection = 'Partner Update Brief'

async function signIn(page: Page, key: keyof typeof localnetUsers) {
  await page.goto('/login?next=/')
  await page.getByLabel('Email').fill(localnetUsers[key].email)
  await page.getByLabel('Password').fill(localnetUsers[key].password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL('/')
}

function articleTitles(page: Page): Locator {
  return page.getByRole('article').locator('h2')
}

async function expectArticleTitles(page: Page, expected: readonly string[]) {
  await expect(articleTitles(page)).toHaveText([...expected])
}

async function expectRelativeOrder(page: Page, expected: readonly string[]) {
  await expect
    .poll(
      async () => {
        const feedTitles = await articleTitles(page)
          .allTextContents()
          .catch(() => [])
        const positions = expected.map((title) => feedTitles.indexOf(title))
        const present = positions.every((position) => position !== -1)
        const ordered = positions.every(
          (position, index) => index === 0 || positions[index - 1] <= position,
        )

        return present && ordered
      },
      { message: `expected titles present in order: ${expected.join(', ')}` },
    )
    .toBe(true)
}

test('anonymous feed lists only public pages newest-first without leaking gated titles', async ({
  page,
}) => {
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)

  await expect(page.getByRole('heading', { name: 'Reports for close reading.' })).toBeVisible()
  await expectRelativeOrder(page, [publicNewest, publicSecondCollection, publicOlder])
  await expect(page.getByText(defaultTitle)).toHaveCount(0)
  await expect(page.getByText(passwordTitle)).toHaveCount(0)
  await expect(page.getByText(privateTitle)).toHaveCount(0)
})

test('domain user feed lists default and password pages with lock affordance', async ({ page }) => {
  await signIn(page, 'secondUser')

  await expectRelativeOrder(page, [
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

  await expectRelativeOrder(page, [
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
  await expectArticleTitles(page, [publicNewest, publicOlder])
  await expect(page.getByText(passwordTitle)).toHaveCount(0)

  await signIn(page, 'secondUser')
  response = await page.goto('/c/market-notes')
  expect(response?.status()).toBe(200)
  await expectArticleTitles(page, [publicNewest, passwordTitle, publicOlder])
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
