import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Request } from '@playwright/test'

import { designTokens } from '../apps/web/src/design/tokens'

const widths = [360, 768, 1280, 1920] as const
const colorSchemes = ['light', 'dark'] as const
const allowedFontFamilies = new Set(Object.values(designTokens.fontFamilies))
const allowedFontSizes = new Set(Object.values(designTokens.typeScale))
const allowedSpacing = new Set(Object.values(designTokens.spacingScale))
const designScopeSelector = '[data-design-scope]'
const designSampleSelector = `${designScopeSelector} *`
const feedEntrySelector = '[data-feed-entry]'

async function collectRequests(page: Page, run: () => Promise<void>): Promise<Request[]> {
  const requests: Request[] = []
  page.on('request', (request) => {
    requests.push(request)
  })
  await run()
  return requests
}

async function gotoHome(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator(designScopeSelector).waitFor()
  await page.locator(designSampleSelector).first().waitFor()
}

function pixelValue(raw: string): number {
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`expected CSS pixel value, received "${raw}"`)
  }
  return Math.round(value)
}

test('localnet serves the press feed shell', async ({ page }) => {
  const response = await page.goto('/')

  expect(response?.status()).toBe(200)
  await expect(page.getByRole('link', { name: 'press' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /publishing home/i })).toBeVisible()
  await expect(page.getByRole('article')).toHaveCount(3)
})

for (const colorScheme of colorSchemes) {
  test.describe(`design floors in ${colorScheme} mode`, () => {
    test.use({ colorScheme })

    for (const width of widths) {
      test(`has no horizontal scroll at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await gotoHome(page)

        const dimensions = await page.evaluate(() => ({
          body: document.body.scrollWidth,
          document: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
        }))

        expect(Math.max(dimensions.body, dimensions.document)).toBeLessThanOrEqual(
          dimensions.viewport,
        )
      })
    }

    test('passes automated accessibility and contrast checks', async ({ page }) => {
      await gotoHome(page)

      const results = await new AxeBuilder({ page }).analyze()
      expect(results.violations).toEqual([])
    })

    test('makes no third-party requests', async ({ page, baseURL }) => {
      const origin = new URL(baseURL ?? page.url()).origin
      const requests = await collectRequests(page, async () => {
        await gotoHome(page)
      })

      const foreignRequests = requests
        .map((request) => request.url())
        .filter((url) => new URL(url).origin !== origin)

      expect(foreignRequests).toEqual([])
    })

    test('keeps cumulative layout shift below the floor', async ({ page }) => {
      await page.addInitScript(() => {
        window.pressLayoutShiftScore = 0
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const layoutShift = entry as PerformanceEntry & {
              readonly hadRecentInput: boolean
              readonly value: number
            }
            if (!layoutShift.hadRecentInput) {
              window.pressLayoutShiftScore += layoutShift.value
            }
          }
        }).observe({ type: 'layout-shift', buffered: true })
      })

      await gotoHome(page)
      await page.getByRole('heading', { name: /publishing home/i }).waitFor()

      const cls = await page.evaluate(
        () => (window as unknown as { pressLayoutShiftScore: number }).pressLayoutShiftScore,
      )
      expect(cls).toBeLessThan(0.1)
    })

    test('uses only configured typefaces', async ({ page }) => {
      await gotoHome(page)
      await page.evaluate(() => document.fonts.ready)

      const families = await page
        .locator(designSampleSelector)
        .evaluateAll((nodes) =>
          nodes
            .map((node) =>
              getComputedStyle(node).fontFamily.split(',')[0]?.replaceAll('"', '').trim(),
            )
            .filter((family): family is string => Boolean(family)),
        )

      expect(families, 'typeface floor sampled no rendered design-scope nodes').not.toHaveLength(0)
      expect(new Set(families)).toEqual(allowedFontFamilies)
    })

    test('uses only configured type-scale sizes', async ({ page }) => {
      await gotoHome(page)

      const sizes = await page
        .locator(designSampleSelector)
        .evaluateAll((nodes) =>
          nodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
        )
      const roundedSizes = sizes.map(Math.round)

      expect(
        roundedSizes,
        'type-scale floor sampled no rendered design-scope nodes',
      ).not.toHaveLength(0)
      expect(new Set(roundedSizes)).toEqual(
        new Set(roundedSizes.filter((size) => allowedFontSizes.has(size))),
      )
    })

    test('uses spacing scale for feed entries', async ({ page }) => {
      await gotoHome(page)

      const { entryCount, spacing } = await page
        .locator(feedEntrySelector)
        .evaluateAll((nodes) => ({
          entryCount: nodes.length,
          spacing: nodes.flatMap((node) => {
            const style = getComputedStyle(node)
            return [
              style.paddingTop,
              style.paddingRight,
              style.paddingBottom,
              style.paddingLeft,
              style.marginTop,
              style.marginRight,
              style.marginBottom,
              style.marginLeft,
            ]
          }),
        }))

      expect(entryCount, 'spacing floor sampled no rendered feed-entry nodes').toBeGreaterThan(0)
      expect(spacing, 'spacing floor sampled no spacing values').not.toHaveLength(0)
      expect(spacing.map(pixelValue).every((value) => allowedSpacing.has(value))).toBe(true)
    })
  })
}
