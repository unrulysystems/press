import { describe, expect, test } from 'bun:test'

import { buildDoctorReport, createLoopbackCallbackHandler } from './index'

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

describe('buildDoctorReport', () => {
  const host = 'https://press.send.it'

  test('reports unauthenticated with setup guidance when no token is found', () => {
    const report = buildDoctorReport({ host, tokenSource: 'none', whoami: null })
    expect(report.authenticated).toBe(false)
    expect(report.email).toBeNull()
    expect(report.tokenSource).toBe('none')
    // Guidance names both the interactive and the agent paths.
    expect(report.nextStep).toContain('press login')
    expect(report.nextStep).toContain('PRESS_TOKEN')
    expect(report.nextStep).toContain('PRESS_HOST')
  })

  test('reports authenticated with the resolved identity and no next step', () => {
    const report = buildDoctorReport({
      host,
      tokenSource: 'env',
      whoami: { ok: true, email: 'agent@send.it' },
    })
    expect(report.authenticated).toBe(true)
    expect(report.email).toBe('agent@send.it')
    expect(report.tokenSource).toBe('env')
    expect(report.nextStep).toBeNull()
  })

  test('flags a present-but-rejected token with the rejection detail', () => {
    const report = buildDoctorReport({
      host,
      tokenSource: 'keychain',
      whoami: { ok: false, error: 'request failed with HTTP 401' },
    })
    expect(report.authenticated).toBe(false)
    expect(report.tokenSource).toBe('keychain')
    expect(report.nextStep).toContain('token was rejected')
    expect(report.detail).toBe('request failed with HTTP 401')
  })
})
