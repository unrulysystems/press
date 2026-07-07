import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  KeychainWriteError,
  readKeychainToken,
  removeKeychainToken,
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
