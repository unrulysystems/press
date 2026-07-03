import { describe, expect, test } from 'bun:test'

import { createLoopbackCallbackHandler } from './index'

describe('createLoopbackCallbackHandler', () => {
  test('ignores mismatched state and waits for a matching callback', async () => {
    let resolvedCode: string | undefined
    const fetch = createLoopbackCallbackHandler({
      state: 'expected-state',
      resolveCode(code) {
        resolvedCode = code
      },
    })

    const rejected = fetch(
      new Request('http://127.0.0.1:4321/callback?code=bogus&state=wrong-state'),
    )
    expect(rejected.status).toBe(400)
    expect(await rejected.text()).toBe('press login rejected\n')
    expect(resolvedCode).toBeUndefined()

    const missingCode = fetch(new Request('http://127.0.0.1:4321/callback?state=expected-state'))
    expect(missingCode.status).toBe(400)
    expect(resolvedCode).toBeUndefined()

    const accepted = fetch(
      new Request('http://127.0.0.1:4321/callback?code=real-code&state=expected-state'),
    )
    expect(accepted.status).toBe(200)
    expect(await accepted.text()).toBe('press login complete\n')
    expect(resolvedCode).toBe('real-code')
  })

  test('keeps non-callback paths outside the authorization flow', () => {
    const fetch = createLoopbackCallbackHandler({
      state: 'expected-state',
      resolveCode() {
        throw new Error('non-callback path resolved a code')
      },
    })

    expect(fetch(new Request('http://127.0.0.1:4321/')).status).toBe(404)
  })
})
