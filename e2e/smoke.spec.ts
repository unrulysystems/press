import { expect, test } from '@playwright/test'

test('localnet serves the placeholder home page', async ({ request }) => {
  const response = await request.get('/')

  expect(response.status()).toBe(200)
  await expect(response.text()).resolves.toContain('press localnet placeholder')
})
