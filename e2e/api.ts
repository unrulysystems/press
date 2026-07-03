import { request as playwrightRequest } from '@playwright/test'

import type { APIRequestContext } from '@playwright/test'

type APIContextOptions = NonNullable<Parameters<typeof playwrightRequest.newContext>[0]>

export function newE2EAPIContext(options: APIContextOptions = {}): Promise<APIRequestContext> {
  // Keep the helper as the harness seam for future API context policy.
  return playwrightRequest.newContext(options)
}
