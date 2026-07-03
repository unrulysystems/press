import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page, type Request } from '@playwright/test'

import { localnetUsers } from '../apps/web/src/auth/localnetFixtures'
import { designTokens } from '../apps/web/src/design/tokens'

const widths = [360, 768, 1280, 1920] as const
const colorSchemes = ['light', 'dark'] as const
const allowedFontFamilies = new Set(Object.values(designTokens.fontFamilies))
const allowedFontSizes = new Set(Object.values(designTokens.typeScale))
const allowedSpacing = new Set(Object.values(designTokens.spacingScale))
const designScopeSelector = '[data-design-scope]'
const designSampleSelector = `${designScopeSelector} *`
const spacingSampleSelector = '[data-spacing-sample]'
const shellSelector = `${designScopeSelector} > .press-shell`
const passwordTitle = 'Checkout Cohort Notes'
const floorRoutes = [
  { path: '/', label: 'feed' },
  { path: '/c/market-notes', label: 'collection' },
  { path: '/login', label: 'login' },
] as const

async function collectRequests(page: Page, run: () => Promise<void>): Promise<Request[]> {
  const requests: Request[] = []
  page.on('request', (request) => {
    requests.push(request)
  })
  await run()
  return requests
}

async function gotoDesignRoute(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.locator(designScopeSelector).waitFor()
  await page.locator(designSampleSelector).first().waitFor()
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login?next=/')
  await page.getByLabel('Email').fill(localnetUsers.secondUser.email)
  await page.getByLabel('Password').fill(localnetUsers.secondUser.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL('/')
}

function pixelValue(raw: string): number {
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`expected CSS pixel value, received "${raw}"`)
  }
  return Math.round(value)
}

async function titleLink(page: Page, title: string): Promise<Locator> {
  const article = page.getByRole('article').filter({ hasText: title })
  await expect(article, `article missing for title "${title}"`).toHaveCount(1)
  return article.getByRole('link').filter({ has: page.getByRole('heading', { name: title }) })
}

async function titleStyle(page: Page, title: string) {
  const article = page.getByRole('article').filter({ hasText: title })
  await expect(article, `article missing for title "${title}"`).toHaveCount(1)
  return await article.getByRole('heading', { name: title }).evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      color: style.color,
      fontFamily: style.fontFamily.split(',')[0]?.replaceAll('"', '').trim(),
      fontWeight: style.fontWeight,
      textDecorationColor: style.textDecorationColor,
      textDecorationLine: style.textDecorationLine,
    }
  })
}

test('localnet serves the press feed shell', async ({ page }) => {
  const response = await page.goto('/')

  expect(response?.status()).toBe(200)
  await expect(page.getByRole('link', { name: 'press' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /reports for close reading/i })).toBeVisible()
  await expect(page.getByRole('article').first()).toBeVisible()
})

for (const colorScheme of colorSchemes) {
  test.describe(`design floors in ${colorScheme} mode`, () => {
    test.use({ colorScheme })

    test('feed, collection, and login share the same page measure at 1280px', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 })

      const measures = []
      for (const route of floorRoutes) {
        // oxlint-disable-next-line no-await-in-loop -- One page navigates route-by-route so margin evidence is comparable.
        await gotoDesignRoute(page, route.path)
        // oxlint-disable-next-line no-await-in-loop -- Assertion belongs to the current route's document.
        await expect(page.locator(shellSelector)).toHaveCount(1)

        measures.push(
          // oxlint-disable-next-line no-await-in-loop -- Layout sampling must observe the route currently loaded above.
          await page.locator(shellSelector).evaluate((node, label) => {
            const rect = node.getBoundingClientRect()
            const style = getComputedStyle(node)
            return {
              label,
              left: Math.round(rect.left),
              marginLeft: Math.round(Number.parseFloat(style.marginLeft)),
              marginRight: Math.round(Number.parseFloat(style.marginRight)),
              maxWidth: Math.round(Number.parseFloat(style.maxWidth)),
              right: Math.round(window.innerWidth - rect.right),
              width: Math.round(rect.width),
            }
          }, route.label),
        )
      }

      expect(measures, 'page-measure floor sampled no design shells').toHaveLength(
        floorRoutes.length,
      )
      expect(new Set(measures.map((measure) => measure.maxWidth))).toEqual(
        new Set([designTokens.measureScale.page]),
      )
      expect(new Set(measures.map((measure) => measure.width))).toEqual(
        new Set([designTokens.measureScale.page]),
      )
      expect(new Set(measures.map((measure) => measure.marginLeft))).toHaveSize(1)
      expect(new Set(measures.map((measure) => measure.marginRight))).toHaveSize(1)
      expect(new Set(measures.map((measure) => measure.left))).toHaveSize(1)
      expect(new Set(measures.map((measure) => measure.right))).toHaveSize(1)
    })

    for (const width of widths) {
      for (const route of floorRoutes) {
        test(`${route.label} has no horizontal scroll at ${width}px`, async ({ page }) => {
          await page.setViewportSize({ width, height: 900 })
          await gotoDesignRoute(page, route.path)

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
    }

    for (const route of floorRoutes) {
      test(`${route.label} passes automated accessibility and contrast checks`, async ({
        page,
      }) => {
        await gotoDesignRoute(page, route.path)

        const results = await new AxeBuilder({ page }).analyze()
        expect(results.violations).toEqual([])
      })

      test(`${route.label} makes no third-party requests`, async ({ page, baseURL }) => {
        const origin = new URL(baseURL ?? page.url()).origin
        const requests = await collectRequests(page, async () => {
          await gotoDesignRoute(page, route.path)
        })

        const foreignRequests = requests
          .map((request) => request.url())
          .filter((url) => new URL(url).origin !== origin)

        expect(foreignRequests).toEqual([])
      })

      test(`${route.label} uses only configured typefaces`, async ({ page }) => {
        await gotoDesignRoute(page, route.path)
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

        expect(families, 'typeface floor sampled no rendered design-scope nodes').not.toHaveLength(
          0,
        )
        expect(new Set(families)).toEqual(allowedFontFamilies)
      })

      test(`${route.label} uses only configured type-scale sizes`, async ({ page }) => {
        await gotoDesignRoute(page, route.path)

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
    }

    test('feed keeps cumulative layout shift below the floor', async ({ page }) => {
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

      await gotoDesignRoute(page, '/')
      await page.getByRole('heading', { name: /reports for close reading/i }).waitFor()

      const cls = await page.evaluate(
        () => (window as unknown as { pressLayoutShiftScore: number }).pressLayoutShiftScore,
      )
      expect(cls).toBeLessThan(0.1)
    })

    test('locked entry title treatment is identical across feed and collection states', async ({
      page,
    }) => {
      await signIn(page)

      await gotoDesignRoute(page, '/')
      const feedDefault = await titleStyle(page, passwordTitle)
      const feedLink = await titleLink(page, passwordTitle)
      await feedLink.hover()
      const feedHover = await titleStyle(page, passwordTitle)
      await page.mouse.move(0, 0)
      await feedLink.focus()
      const feedFocus = await titleStyle(page, passwordTitle)

      await gotoDesignRoute(page, '/c/market-notes')
      const collectionDefault = await titleStyle(page, passwordTitle)
      const collectionLink = await titleLink(page, passwordTitle)
      await collectionLink.hover()
      const collectionHover = await titleStyle(page, passwordTitle)
      await page.mouse.move(0, 0)
      await collectionLink.focus()
      const collectionFocus = await titleStyle(page, passwordTitle)

      expect(collectionDefault).toEqual(feedDefault)
      expect(collectionHover).toEqual(feedHover)
      expect(collectionFocus).toEqual(feedFocus)
      expect(feedDefault.color).toBe(feedHover.color)
      expect(feedDefault.color).toBe(feedFocus.color)
      expect(collectionDefault.color).toBe(collectionHover.color)
      expect(collectionDefault.color).toBe(collectionFocus.color)
      expect(feedHover.textDecorationLine).toContain('underline')
      expect(collectionHover.textDecorationLine).toContain('underline')
    })

    test('locked entry affordance and muted metadata keep AA contrast', async ({ page }) => {
      await signIn(page)

      const samples = []
      for (const route of ['/', '/c/market-notes'] as const) {
        // oxlint-disable-next-line no-await-in-loop -- The contrast sample is bound to each navigated route.
        await gotoDesignRoute(page, route)
        // oxlint-disable-next-line no-await-in-loop -- This verifies the route rendered a locked listing before sampling.
        await expect(page.locator('.press-lock')).not.toHaveCount(0)
        samples.push(
          // oxlint-disable-next-line no-await-in-loop -- Browser-context contrast evidence is route-local.
          ...(await page.evaluate(() => {
            // oxlint-disable-next-line unicorn/consistent-function-scoping -- Browser-context helper for page.evaluate.
            function parseRgb(raw: string): readonly [number, number, number, number] {
              const channels = raw.match(/[\d.]+/g)?.map(Number) ?? []
              if (channels.length < 3) {
                throw new Error(`expected rgb color, received "${raw}"`)
              }
              return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, channels[3] ?? 1]
            }

            // oxlint-disable-next-line unicorn/consistent-function-scoping -- Browser-context helper for page.evaluate.
            function relativeLuminance([red, green, blue]: readonly number[]): number {
              const [r, g, b] = [red, green, blue].map((channel) => {
                const normalized = channel / 255
                return normalized <= 0.03928
                  ? normalized / 12.92
                  : ((normalized + 0.055) / 1.055) ** 2.4
              })
              return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
            }

            function contrastRatio(foreground: string, background: string): number {
              const foregroundLuminance = relativeLuminance(parseRgb(foreground))
              const backgroundLuminance = relativeLuminance(parseRgb(background))
              const lighter = Math.max(foregroundLuminance, backgroundLuminance)
              const darker = Math.min(foregroundLuminance, backgroundLuminance)
              return (lighter + 0.05) / (darker + 0.05)
            }

            function opaqueBackground(node: Element): string {
              let current: Element | null = node
              while (current) {
                const background = getComputedStyle(current).backgroundColor
                if (parseRgb(background)[3] !== 0) {
                  return background
                }
                current = current.parentElement
              }
              return getComputedStyle(document.body).backgroundColor
            }

            return ['.press-lock', '.press-entry-meta', '.press-meta', '.press-kicker']
              .flatMap((selector) =>
                [...document.querySelectorAll(selector)].map((node) => {
                  const style = getComputedStyle(node)
                  const background = opaqueBackground(node)
                  return {
                    ratio: contrastRatio(style.color, background),
                    route: window.location.pathname,
                    selector,
                    text: node.textContent?.trim() ?? '',
                  }
                }),
              )
              .filter((sample) => sample.text.length > 0)
          })),
        )
      }

      expect(samples, 'contrast floor sampled no locked or metadata text').not.toHaveLength(0)
      expect(samples.some((sample) => sample.selector === '.press-lock')).toBe(true)
      for (const sample of samples) {
        expect(
          sample.ratio,
          `${sample.selector} on ${sample.route} failed AA contrast for "${sample.text}"`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    })

    for (const route of floorRoutes) {
      test(`${route.label} uses spacing scale for feed entries`, async ({ page }) => {
        await gotoDesignRoute(page, route.path)

        const { sampleCount, spacing } = await page
          .locator(spacingSampleSelector)
          .evaluateAll((nodes) => ({
            sampleCount: nodes.length,
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

        expect(sampleCount, 'spacing floor sampled no rendered nodes').toBeGreaterThan(0)
        expect(spacing, 'spacing floor sampled no spacing values').not.toHaveLength(0)
        expect(spacing.map(pixelValue).every((value) => allowedSpacing.has(value))).toBe(true)
      })
    }
  })
}
