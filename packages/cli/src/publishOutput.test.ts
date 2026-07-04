import { describe, expect, test } from 'bun:test'

import { formatPublishOutput } from './publishOutput'

describe('formatPublishOutput', () => {
  test('always prints the URL first', () => {
    expect(
      formatPublishOutput({ url: 'https://press.test/p/c/f.html', visibility: 'public' }),
    ).toEqual(['https://press.test/p/c/f.html'])
  })

  test('password page prints the password then reader guidance (F2 / REQ-CLI-004)', () => {
    const lines = formatPublishOutput({
      url: 'https://press.test/p/c/f.html',
      visibility: 'password',
      password: 'hunter2xy',
    })
    expect(lines[0]).toBe('https://press.test/p/c/f.html')
    expect(lines).toContain('password: hunter2xy')
    const guidance = lines.find((l) => /browser prompt/i.test(l) && /username/i.test(l))
    expect(
      guidance,
      'expected reader guidance mentioning the browser prompt and username',
    ).toBeDefined()
  })

  test('private page echoes the resolved allowlist (F4 / REQ-PUB-004)', () => {
    const lines = formatPublishOutput({
      url: 'https://press.test/p/c/f.html',
      visibility: 'private',
      allow: ['a@send.it', 'b@send.it'],
    })
    const allowed = lines.find((l) => l.includes('a@send.it') && l.includes('b@send.it'))
    expect(allowed, 'expected a line echoing the allowlist emails').toBeDefined()
  })

  test('private page with empty allowlist still reports it (owner only)', () => {
    const lines = formatPublishOutput({
      url: 'https://press.test/p/c/f.html',
      visibility: 'private',
      allow: [],
    })
    expect(lines.some((l) => /owner only/i.test(l))).toBe(true)
  })

  test('public page prints no password guidance and no allow line', () => {
    const lines = formatPublishOutput({
      url: 'https://press.test/p/c/f.html',
      visibility: 'public',
    })
    expect(lines).toEqual(['https://press.test/p/c/f.html'])
  })
})
