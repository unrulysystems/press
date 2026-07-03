import type { Endpoint } from 'one'

export const GET: Endpoint = async () => {
  return new Response('ok\n', {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  })
}
