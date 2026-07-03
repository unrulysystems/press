import { defineConfig, devices } from '@playwright/test'

const baseURL =
  process.env.PRESS_BASE_URL ??
  (process.env.PRESS_PORT ? `http://127.0.0.1:${process.env.PRESS_PORT}` : 'http://127.0.0.1:4174')

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
