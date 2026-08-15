import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  chooseTokenStore,
  KeychainWriteError,
  readKeychainToken,
  removeKeychainToken,
  resolveFileTokenPath,
  writeKeychainToken,
} from './keychain'

type TestEnv = {
  readonly PRESS_E2E_KEYCHAIN_FILE?: string | undefined
}

async function withEnv<T>(env: TestEnv, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PRESS_E2E_KEYCHAIN_FILE
  if (env.PRESS_E2E_KEYCHAIN_FILE === undefined) {
    delete process.env.PRESS_E2E_KEYCHAIN_FILE
  } else {
    process.env.PRESS_E2E_KEYCHAIN_FILE = env.PRESS_E2E_KEYCHAIN_FILE
  }
  try {
    return await run()
  } finally {
    if (previous === undefined) {
      delete process.env.PRESS_E2E_KEYCHAIN_FILE
    } else {
      process.env.PRESS_E2E_KEYCHAIN_FILE = previous
    }
  }
}

async function makeKeychainFile(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `press-keychain-${label}-`))
  return join(dir, 'keychain.json')
}

describe('PRESS_E2E_KEYCHAIN_FILE backend', () => {
  test('round-trips, scopes by host, and deletes tokens', async () => {
    const file = await makeKeychainFile('file')
    await withEnv({ PRESS_E2E_KEYCHAIN_FILE: file }, async () => {
      await writeKeychainToken('https://press.test', 'token-one')
      await writeKeychainToken('https://other.test', 'token-two')

      expect(await readKeychainToken('https://press.test')).toBe('token-one')
      expect(await readKeychainToken('https://other.test')).toBe('token-two')

      await removeKeychainToken('https://press.test')
      expect(await readKeychainToken('https://press.test')).toBeNull()
      expect(await readKeychainToken('https://other.test')).toBe('token-two')
    })
  })

  test('refuses empty writes and never records a false login', async () => {
    const file = await makeKeychainFile('empty')
    await withEnv({ PRESS_E2E_KEYCHAIN_FILE: file }, async () => {
      await expect(writeKeychainToken('https://press.test', '')).rejects.toThrow(KeychainWriteError)
      await expect(readFile(file, 'utf8')).rejects.toThrow()
      expect(await readKeychainToken('https://press.test')).toBeNull()
    })
  })

  test('creates parent directories and persists the file mode 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'press-keychain-mode-'))
    const file = join(dir, 'nested', 'keychain.json')
    await withEnv({ PRESS_E2E_KEYCHAIN_FILE: file }, async () => {
      await writeKeychainToken('https://press.test', 'mode-token')
      const info = await stat(file)
      expect(info.mode & 0o777).toBe(0o600)
      expect(await readKeychainToken('https://press.test')).toBe('mode-token')
    })
  })
})

describe('last-resort XDG file store selection', () => {
  test('resolveFileTokenPath prefers XDG_CONFIG_HOME then ~/.config/press/tokens.json', () => {
    expect(resolveFileTokenPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/op')).toBe(
      '/xdg/press/tokens.json',
    )
    expect(resolveFileTokenPath({}, '/home/op')).toBe('/home/op/.config/press/tokens.json')
  })

  test('chooseTokenStore prefers the test seam, then macOS keychain, then the file store', () => {
    expect(
      chooseTokenStore({
        platform: 'darwin',
        testBuild: true,
        testSeam: '/tmp/seam.json',
        keychainAvailable: true,
      }),
    ).toBe('seam')
    expect(
      chooseTokenStore({
        platform: 'darwin',
        testBuild: true,
        keychainAvailable: true,
      }),
    ).toBe('keychain')
    expect(
      chooseTokenStore({
        platform: 'darwin',
        testBuild: false,
        testSeam: '/tmp/seam.json',
        keychainAvailable: true,
      }),
    ).toBe('keychain')
    expect(
      chooseTokenStore({
        platform: 'linux',
        testBuild: false,
        keychainAvailable: false,
      }),
    ).toBe('file')
    expect(
      chooseTokenStore({
        platform: 'darwin',
        testBuild: false,
        keychainAvailable: false,
      }),
    ).toBe('file')
  })
})

if (process.platform === 'darwin' && !process.env.CODEX_SANDBOX) {
  test('macOS Security.framework backend round-trips without argv or a TTY', async () => {
    const host = `https://ffi-${Date.now().toString(36)}.press.invalid`
    await withEnv({ PRESS_E2E_KEYCHAIN_FILE: undefined }, async () => {
      try {
        await writeKeychainToken(host, 'ffi-token')
        expect(await readKeychainToken(host)).toBe('ffi-token')
      } finally {
        await removeKeychainToken(host)
      }
    })
  })
} else {
  test.skip('macOS Security.framework backend round-trips without argv or a TTY', () => {})
}
