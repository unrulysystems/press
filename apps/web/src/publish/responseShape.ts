import type { CollectionSlug, FileSlug, PageVisibility } from '@press/core'

// Pure shape of the publish/patch/re-roll response body, factored out of routes.ts
// (which imports the DB client) so the contract can be unit-tested without a database.
export type PublishResponseInput = {
  readonly baseUrl: string
  readonly collectionSlug: CollectionSlug
  readonly fileSlug: FileSlug
  readonly title: string
  readonly visibility: PageVisibility
  readonly password?: string
  readonly allowlist?: readonly string[]
}

export type PublishResponseBody = {
  readonly url: string
  readonly collection: string
  readonly file: string
  readonly title: string
  readonly visibility: PageVisibility
  readonly password?: string
  readonly allow?: readonly string[]
}

// The response echoes the resolved allowlist only for `private` pages (REQ-PUB-004),
// so a publisher can confirm exactly who was granted; other visibilities have no
// meaningful allowlist to report. An empty private allowlist is reported as `[]`
// (owner-only), never omitted. `password` (when present) is the one-time material.
export function publishResponseBody(input: PublishResponseInput): PublishResponseBody {
  return {
    url: `${input.baseUrl}/p/${input.collectionSlug}/${input.fileSlug}`,
    collection: input.collectionSlug,
    file: input.fileSlug,
    title: input.title,
    visibility: input.visibility,
    ...(input.password ? { password: input.password } : {}),
    ...(input.visibility === 'private' ? { allow: [...(input.allowlist ?? [])] } : {}),
  }
}
