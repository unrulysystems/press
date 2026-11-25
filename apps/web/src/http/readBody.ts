// Bounded request-body reader for small JSON and form endpoints so no request can
// buffer an unbounded payload in memory.
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
      // oxlint-disable-next-line no-await-in-loop -- Cancel happens only at the bounded rejection point.
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
