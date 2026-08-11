// Shared bounded request-body reader (M-3). The publish HTML path keeps its own
// streaming reader in routes.ts (readHtmlBody, capped by PRESS_MAX_UPLOAD_BYTES);
// this helper caps the small anonymous/JSON endpoints so no unauthenticated
// request can make the server buffer an unbounded body.
export class BodyTooLargeError extends Error {
  readonly status = 413

  constructor(byteLimit: number) {
    super(`request body exceeds ${byteLimit} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

export async function readCappedBodyText(request: Request, byteLimit: number): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) {
    return ''
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- The stream must be consumed sequentially.
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > byteLimit) {
      // Cancel the stream so a hostile client cannot stall the keep-alive
      // connection while the server rejects the oversized body.
      await reader.cancel('request body too large').catch(() => undefined)
      throw new BodyTooLargeError(byteLimit)
    }
    chunks.push(value)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}
