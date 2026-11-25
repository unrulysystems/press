// A publisher-supplied page password must never reach argv or a query string (INV-4).
// `press ... --password` is a value-less flag that acquires the password out-of-band
// and sends it in a request header (REQ-PUB-005 / REQ-CLI-001).

export const MAX_PAGE_PASSWORD_BYTES = 1024

export type PagePasswordSource =
  | { readonly kind: 'env'; readonly value: string }
  | { readonly kind: 'stdin' }
  | { readonly kind: 'prompt' }

// Precedence: PRESS_PAGE_PASSWORD (agents / CI) > stdin (non-interactive pipe) >
// hidden interactive prompt (a human at a TTY).
export function pagePasswordSource(env: string | undefined, isTTY: boolean): PagePasswordSource {
  if (env) {
    return { kind: 'env', value: env }
  }
  if (!isTTY) {
    return { kind: 'stdin' }
  }
  return { kind: 'prompt' }
}

async function readStdin(): Promise<string> {
  const reader = Bun.stdin.stream().getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- stdin stream is consumed sequentially.
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > MAX_PAGE_PASSWORD_BYTES) {
      // oxlint-disable-next-line no-await-in-loop -- Cancel once at the bounded rejection point.
      await reader.cancel('page password too long').catch(() => undefined)
      throw new Error(`page password exceeds ${MAX_PAGE_PASSWORD_BYTES} bytes`)
    }
    chunks.push(value)
  }
  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(combined).replace(/\r?\n$/, '')
}

const KEY_ENTER = '\r'
const KEY_NEWLINE = '\n'
const KEY_EOT = String.fromCharCode(4) // ctrl-d
const KEY_INTERRUPT = String.fromCharCode(3) // ctrl-c
const KEY_BACKSPACE = String.fromCharCode(127) // DEL

// Read one line from a TTY without echoing it. The prompt goes to stderr so stdout stays clean.
async function promptHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt)
  const stdin = process.stdin
  stdin.setRawMode?.(true)
  stdin.resume()
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = ''
      const onData = (chunk: Buffer): void => {
        const char = chunk.toString('utf8')
        if (char === KEY_ENTER || char === KEY_NEWLINE || char === KEY_EOT) {
          stdin.removeListener('data', onData)
          resolve(value)
        } else if (char === KEY_INTERRUPT) {
          stdin.removeListener('data', onData)
          reject(new Error('cancelled'))
        } else if (char === KEY_BACKSPACE || char === '\b') {
          value = value.slice(0, -1)
        } else {
          value += char
          if (Buffer.byteLength(value, 'utf8') > MAX_PAGE_PASSWORD_BYTES) {
            stdin.removeListener('data', onData)
            reject(new Error(`page password exceeds ${MAX_PAGE_PASSWORD_BYTES} bytes`))
          }
        }
      }
      stdin.on('data', onData)
    })
  } finally {
    stdin.setRawMode?.(false)
    stdin.pause()
    process.stderr.write('\n')
  }
}

export async function readPagePassword(): Promise<string> {
  const source = pagePasswordSource(process.env.PRESS_PAGE_PASSWORD, Boolean(process.stdin.isTTY))
  const value =
    source.kind === 'env'
      ? source.value
      : source.kind === 'stdin'
        ? await readStdin()
        : await promptHidden('Page password: ')
  if (!value) {
    throw new Error('no page password provided (set PRESS_PAGE_PASSWORD, pipe stdin, or type one)')
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_PAGE_PASSWORD_BYTES) {
    throw new Error(`page password exceeds ${MAX_PAGE_PASSWORD_BYTES} bytes`)
  }
  return value
}
