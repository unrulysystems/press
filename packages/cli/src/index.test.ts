import { describe, expect, test } from 'bun:test'

import cliPackage from '../package.json' with { type: 'json' }

import {
  buildDoctorReport,
  CLI_VERSION,
  createLoopbackCallbackHandler,
  nextDevicePollAction,
  parseLoginArguments,
  parseMoveArguments,
} from './index'

describe('CLI_VERSION', () => {
  test('matches the package version used for releases', () => {
    expect(CLI_VERSION).toBe(cliPackage.version)
  })
})

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

  test('reports a last-resort file store as the token source', () => {
    const report = buildDoctorReport({
      host,
      tokenSource: 'file',
      whoami: { ok: true, email: 'owner@send.it' },
    })
    expect(report.authenticated).toBe(true)
    expect(report.tokenSource).toBe('file')
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

describe('parseLoginArguments', () => {
  test('defaults to loopback and treats --device as opt-in', () => {
    expect(parseLoginArguments([])).toEqual({ device: false, noOpen: false })
    expect(parseLoginArguments(['--device'])).toEqual({ device: true, noOpen: false })
    expect(parseLoginArguments(['--device', '--no-open'])).toEqual({ device: true, noOpen: true })
  })
})

describe('nextDevicePollAction', () => {
  test('waits on pending and slow_down, fails closed on deny/expiry', () => {
    expect(nextDevicePollAction('authorization_pending', 5)).toEqual({ kind: 'wait', interval: 5 })
    expect(nextDevicePollAction('slow_down', 5)).toEqual({ kind: 'wait', interval: 10 })
    expect(nextDevicePollAction('access_denied', 5)).toEqual({
      kind: 'fail',
      message: 'login was denied',
    })
    expect(nextDevicePollAction('expired_token', 5)).toEqual({
      kind: 'fail',
      message: 'login expired',
    })
    expect(nextDevicePollAction('invalid_grant', 5)).toEqual({
      kind: 'fail',
      message: 'invalid_grant',
    })
  })
})

describe('parseMoveArguments', () => {
  test('defaults to a permanent redirect', () => {
    expect(parseMoveArguments(['reports/old.html', 'archive/new.html'])).toEqual({
      source: { collection: 'reports', file: 'old.html' },
      destination: { collection: 'archive', file: 'new.html' },
      redirect: 'permanent',
    })
  })

  test('accepts an explicit no-redirect move', () => {
    expect(
      parseMoveArguments(['reports/old.html', 'archive/new.html', '--redirect', 'none']),
    ).toMatchObject({ redirect: 'none' })
  })

  test('rejects unsupported modes and malformed targets', () => {
    expect(() =>
      parseMoveArguments(['reports/old.html', 'archive/new.html', '--redirect', 'temporary']),
    ).toThrow('redirect must be one of permanent, none')
    expect(() => parseMoveArguments(['reports/old.html'])).toThrow(
      'move requires <source> <destination>',
    )
    expect(() => parseMoveArguments(['reports/old.html', 'bad-target'])).toThrow(
      'target must be <collection>/<file>',
    )
  })
})
