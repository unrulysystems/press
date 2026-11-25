import { decodeHTML } from 'entities'

import type { FileSlug } from '@press/core'

export const MAX_TITLE_LENGTH = 500

// Extract the display title for a published page from its HTML `<title>`, falling back to
// the file slug. `override` is an explicit `--title`/`title=` value and is already a plain
// string, so it is returned bounded to MAX_TITLE_LENGTH.
export function extractTitle(html: string, fileSlug: FileSlug, override?: string): string {
  if (override) {
    return override.slice(0, MAX_TITLE_LENGTH)
  }
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  // Decode HTML character references before collapsing whitespace so entities such as
  // &#10; or &nbsp; fold cleanly. Output sinks escape stored titles on render.
  const raw = match?.[1]
  const extracted =
    raw === undefined
      ? undefined
      : decodeHTML(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH)
  return extracted || fileSlug
}
