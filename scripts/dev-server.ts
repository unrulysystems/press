import { parseConfig } from '@press/core'

const MARKER_TEXT = 'press localnet placeholder'

function parsePort(raw: string | undefined, fallback: string): number {
  const port = Number(raw ?? fallback)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PRESS_PORT: must be an integer between 1 and 65535')
  }
  return port
}

const config = parseConfig(process.env)
const port = parsePort(process.env.PRESS_PORT, new URL(config.baseUrl).port || '4174')

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === '/healthz') {
      return new Response('ok\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }

    if (url.pathname === '/') {
      return new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>press localnet</title></head><body><main><h1>${MARKER_TEXT}</h1></main></body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      )
    }

    return new Response('not found\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  },
})

console.log(`press localnet placeholder listening on http://127.0.0.1:${server.port}`)

const parentPid = Number(process.env.PRESS_PARENT_PID)
if (Number.isInteger(parentPid) && parentPid > 0) {
  const parentCheck = setInterval(() => {
    try {
      process.kill(parentPid, 0)
    } catch {
      server.stop(true)
      process.exit(0)
    }
  }, 1_000)
  parentCheck.unref()
}
