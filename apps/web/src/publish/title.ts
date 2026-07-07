import { decodeHTML } from 'entities'

import type { FileSlug } from '@press/core'

// Extract the display title for a published page from its HTML `<title>`, falling back to
// the file slug. `override` is an explicit `--title`/`title=` value and is already a plain
// string, so it is returned untouched.
export function extractTitle(html: string, fileSlug: FileSlug, override?: string): string {
  if (override) {
    return override
  }
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  // The content of a <title> is parsed character data: an HTML parser decodes character
  // references (&mdash; -> —, &amp; -> &, &#8212; / &#x2014;) to produce the real title. The
  // regex above skips that step, so decode here — before collapsing whitespace, since entities
  // like &#10; / &nbsp; decode into whitespace that the collapse should then fold. Output sinks
  // still HTML-escape the stored value (escapeHtml + JSX), so decoding does not open title XSS.
  const raw = match?.[1]
  const extracted = raw === undefined ? undefined : decodeHTML(raw).replace(/\s+/g, ' ').trim()
  return extracted || fileSlug
}
