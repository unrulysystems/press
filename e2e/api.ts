import { request as playwrightRequest } from '@playwright/test'

import type { APIRequestContext } from '@playwright/test'

type APIContextOptions = NonNullable<Parameters<typeof playwrightRequest.newContext>[0]>

export function newE2EAPIContext(options: APIContextOptions = {}): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    ...options,
    extraHTTPHeaders: {
      ...options.extraHTTPHeaders,
      // The One/Vite dev server can close an idle keep-alive socket while
      // Playwright is about to reuse it, yielding EPIPE on non-idempotent API
      // writes. Keep this at the harness boundary instead of retrying writes.
      connection: 'close',
    },
  })
}
