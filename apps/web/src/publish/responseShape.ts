import type { CollectionSlug, FileSlug, PageRedirectMode, PageVisibility } from '@press/core'

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

export type MoveResponseInput = {
  readonly baseUrl: string
  readonly sourceCollectionSlug: CollectionSlug
  readonly sourceFileSlug: FileSlug
  readonly destinationCollectionSlug: CollectionSlug
  readonly destinationFileSlug: FileSlug
  readonly redirect: PageRedirectMode
  readonly title: string
  readonly visibility: PageVisibility
}

type MoveResponsePath = {
  readonly url: string
  readonly collection: string
  readonly file: string
}

export type MoveResponseBody = {
  readonly source: MoveResponsePath
  readonly destination: MoveResponsePath
  readonly redirect: PageRedirectMode
  readonly title: string
  readonly visibility: PageVisibility
}

function responsePath(
  baseUrl: string,
  collectionSlug: CollectionSlug,
  fileSlug: FileSlug,
): MoveResponsePath {
  return {
    url: `${baseUrl}/p/${collectionSlug}/${fileSlug}`,
    collection: collectionSlug,
    file: fileSlug,
  }
}

export function moveResponseBody(input: MoveResponseInput): MoveResponseBody {
  return {
    source: responsePath(input.baseUrl, input.sourceCollectionSlug, input.sourceFileSlug),
    destination: responsePath(
      input.baseUrl,
      input.destinationCollectionSlug,
      input.destinationFileSlug,
    ),
    redirect: input.redirect,
    title: input.title,
    visibility: input.visibility,
  }
}
