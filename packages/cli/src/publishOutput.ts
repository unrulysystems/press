// Human-readable lines printed after a successful `press publish` / `press page set`.
// Factored out of index.ts so the output contract is unit-testable. `--json` output
// is handled separately by the caller and stays machine-clean (no prose here).
export type PublishOutputBody = {
  readonly url?: unknown
  readonly visibility?: unknown
  readonly password?: unknown
  readonly allow?: unknown
}

export function formatPublishOutput(body: PublishOutputBody): string[] {
  const lines: string[] = []
  if (typeof body.url === 'string') {
    lines.push(body.url)
  }
  // Password pages: print the effective password once, then tell the publisher how a
  // reader unlocks it — readers open the link and type the password on the branded
  // entry page (F1/F2 / REQ-CLI-004 / REQ-SRV-004).
  if (typeof body.password === 'string') {
    lines.push(`password: ${body.password}`)
    lines.push('share the link; readers open it and enter this password on the page to read it')
  }
  // Private pages: echo the resolved allowlist so the publisher can confirm exactly
  // who was granted (F4 / REQ-PUB-004).
  if (body.visibility === 'private' && Array.isArray(body.allow)) {
    const emails = body.allow.filter((entry): entry is string => typeof entry === 'string')
    lines.push(`allowed: ${emails.length > 0 ? emails.join(', ') : '(owner only)'}`)
  }
  return lines
}
