import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { dlopen, FFIType as T, ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi'

// Per-host token storage for the `press` CLI (REQ-AUTH-006: OS keychain first,
// then XDG 0600 file store, then PRESS_TOKEN). Binds macOS Keychain Services
// directly via bun:ffi so secrets travel in-process as CFData without argv or TTY.

// Long enough that CoreFoundation allocates a normal CFString rather than a tagged pointer.
const account = 'press-cli-token'

function serviceName(host: string): string {
  return `press:${host}`
}

export class KeychainUnavailableError extends Error {
  constructor(message = 'macOS keychain is unavailable', options?: ErrorOptions) {
    super(message, options)
    this.name = 'KeychainUnavailableError'
  }
}

export class KeychainWriteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'KeychainWriteError'
  }
}

type Backend = {
  readonly store: (service: string, token: string) => void
  readonly find: (service: string) => string | null
  readonly remove: (service: string) => void
}

type FileState = Record<string, string>

function readFileState(file: string): FileState {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {}
    }
    throw new KeychainWriteError(
      `failed to read token store ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new KeychainWriteError(`token store ${file} contains invalid JSON`, { cause: error })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new KeychainWriteError(`token store ${file} must contain a JSON object`)
  }
  return parsed as FileState
}

function fileBackend(file: string): Backend {
  const key = (service: string): string => `${service}:${account}`
  const persist = (state: FileState): void => {
    const dir = dirname(file)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tempPath = join(dir, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`)
    try {
      writeFileSync(tempPath, JSON.stringify(state), { mode: 0o600 })
      chmodSync(tempPath, 0o600)
      renameSync(tempPath, file)
    } catch (error) {
      try {
        rmSync(tempPath, { force: true })
      } catch {
        // Ignore cleanup error while propagating the write failure.
      }
      throw new KeychainWriteError(
        `failed to write token store ${file}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
  return {
    store(service, token) {
      const state = readFileState(file)
      state[key(service)] = token
      persist(state)
    },
    find(service) {
      const value = readFileState(file)[key(service)]
      return typeof value === 'string' && value.length > 0 ? value : null
    },
    remove(service) {
      const state = readFileState(file)
      if (!(key(service) in state)) {
        return
      }
      delete state[key(service)]
      persist(state)
    },
  }
}

export function resolveFileTokenPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim()
  const base = xdg ? xdg : join(home, '.config')
  return join(base, 'press', 'tokens.json')
}

export function chooseTokenStore(input: {
  readonly platform: string
  readonly testBuild: boolean
  readonly testSeam?: string
  readonly keychainAvailable: boolean
}): 'seam' | 'keychain' | 'file' {
  if (input.testBuild && input.testSeam) {
    return 'seam'
  }
  if (input.platform === 'darwin' && input.keychainAvailable) {
    return 'keychain'
  }
  return 'file'
}

export type StoredCliToken = {
  readonly kind: 'keychain' | 'file'
  readonly token: string
}

// ---- FFI backend: macOS Keychain Services (Security.framework + CoreFoundation) -----------------
const CORE_FOUNDATION = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'
const SECURITY = '/System/Library/Frameworks/Security.framework/Security'
const LIBSYSTEM = '/usr/lib/libSystem.B.dylib'

const K_CF_STRING_ENCODING_UTF8 = 0x08000100
const ERR_SEC_SUCCESS = 0
const ERR_SEC_DUPLICATE_ITEM = -25299
const ERR_SEC_ITEM_NOT_FOUND = -25300

let ffiBackend: Backend | null | undefined

function asPointer(value: number): Pointer {
  return value as Pointer
}

function cstr(value: string): Uint8Array {
  return new TextEncoder().encode(`${value}\0`)
}

function createFfiBackend(): Backend {
  // dlopen/dlsym from libSystem so we can read Security/CoreFoundation data symbols
  // (kSec*/kCF* constants are const CFStringRef globals).
  const libc = dlopen(LIBSYSTEM, {
    dlopen: { args: [T.ptr, T.i32], returns: T.ptr },
    dlsym: { args: [T.ptr, T.ptr], returns: T.ptr },
  })
  const RTLD_NOW = 2
  const cfPathBuf = cstr(CORE_FOUNDATION)
  const secPathBuf = cstr(SECURITY)
  const cfHandle = Number(libc.symbols.dlopen(ptr(cfPathBuf), RTLD_NOW))
  const secHandle = Number(libc.symbols.dlopen(ptr(secPathBuf), RTLD_NOW))
  if (!cfHandle || !secHandle) {
    throw new KeychainUnavailableError('failed to load Security.framework')
  }
  const constRef = (handle: number, name: string): number => {
    const nameBuf = cstr(name)
    const addr = Number(libc.symbols.dlsym(asPointer(handle), ptr(nameBuf)))
    if (!addr) {
      throw new KeychainUnavailableError(`missing keychain constant ${name}`)
    }
    return Number(read.ptr(asPointer(addr), 0))
  }
  const structAddr = (handle: number, name: string): number => {
    const nameBuf = cstr(name)
    const addr = Number(libc.symbols.dlsym(asPointer(handle), ptr(nameBuf)))
    if (!addr) {
      throw new KeychainUnavailableError(`missing keychain constant ${name}`)
    }
    return addr
  }

  const kSecClass = constRef(secHandle, 'kSecClass')
  const kSecClassGenericPassword = constRef(secHandle, 'kSecClassGenericPassword')
  const kSecAttrService = constRef(secHandle, 'kSecAttrService')
  const kSecAttrAccount = constRef(secHandle, 'kSecAttrAccount')
  const kSecValueData = constRef(secHandle, 'kSecValueData')
  const kSecReturnData = constRef(secHandle, 'kSecReturnData')
  const kSecMatchLimit = constRef(secHandle, 'kSecMatchLimit')
  const kSecMatchLimitOne = constRef(secHandle, 'kSecMatchLimitOne')
  const kCFBooleanTrue = constRef(cfHandle, 'kCFBooleanTrue')
  const keyCallbacks = structAddr(cfHandle, 'kCFTypeDictionaryKeyCallBacks')
  const valueCallbacks = structAddr(cfHandle, 'kCFTypeDictionaryValueCallBacks')

  const cf = dlopen(CORE_FOUNDATION, {
    CFStringCreateWithBytes: { args: [T.ptr, T.ptr, T.i64, T.u32, T.bool], returns: T.ptr },
    CFDataCreate: { args: [T.ptr, T.ptr, T.i64], returns: T.ptr },
    CFDictionaryCreate: { args: [T.ptr, T.ptr, T.ptr, T.i64, T.ptr, T.ptr], returns: T.ptr },
    CFRelease: { args: [T.ptr], returns: T.void },
    CFDataGetLength: { args: [T.ptr], returns: T.i64 },
    CFDataGetBytePtr: { args: [T.ptr], returns: T.ptr },
  })
  const security = dlopen(SECURITY, {
    SecItemAdd: { args: [T.ptr, T.ptr], returns: T.i32 },
    SecItemUpdate: { args: [T.ptr, T.ptr], returns: T.i32 },
    SecItemCopyMatching: { args: [T.ptr, T.ptr], returns: T.i32 },
    SecItemDelete: { args: [T.ptr], returns: T.i32 },
  })

  const cfString = (value: string): number => {
    const bytes = new TextEncoder().encode(value)
    const r = Number(
      cf.symbols.CFStringCreateWithBytes(
        null,
        ptr(bytes),
        bytes.length,
        K_CF_STRING_ENCODING_UTF8,
        false,
      ),
    )
    if (!r) {
      throw new KeychainWriteError('CFStringCreateWithBytes failed')
    }
    return r
  }
  const cfData = (value: string): number => {
    const bytes = new TextEncoder().encode(value)
    const r = Number(cf.symbols.CFDataCreate(null, ptr(bytes), bytes.length))
    if (!r) {
      throw new KeychainWriteError('CFDataCreate failed')
    }
    return r
  }
  const cfDict = (pairs: ReadonlyArray<readonly [number, number]>): number => {
    const keys = new BigUint64Array(pairs.length)
    const values = new BigUint64Array(pairs.length)
    pairs.forEach(([k, v], index) => {
      keys[index] = BigInt(k)
      values[index] = BigInt(v)
    })
    const r = Number(
      cf.symbols.CFDictionaryCreate(
        null,
        ptr(keys),
        ptr(values),
        pairs.length,
        asPointer(keyCallbacks),
        asPointer(valueCallbacks),
      ),
    )
    if (!r) {
      throw new KeychainWriteError('CFDictionaryCreate failed')
    }
    return r
  }
  const release = (refs: readonly number[]): void => {
    for (const ref of refs) {
      if (ref) {
        cf.symbols.CFRelease(asPointer(ref))
      }
    }
  }

  return {
    store(service, token) {
      const svc = cfString(service)
      const acct = cfString(account)
      const data = cfData(token)
      const baseQuery: ReadonlyArray<readonly [number, number]> = [
        [kSecClass, kSecClassGenericPassword],
        [kSecAttrService, svc],
        [kSecAttrAccount, acct],
      ]
      const addDict = cfDict([...baseQuery, [kSecValueData, data]])
      const created: number[] = [svc, acct, data, addDict]
      try {
        const status = security.symbols.SecItemAdd(asPointer(addDict), null)
        if (status === ERR_SEC_DUPLICATE_ITEM) {
          const query = cfDict(baseQuery)
          const attrs = cfDict([[kSecValueData, data]])
          created.push(query, attrs)
          const updateStatus = security.symbols.SecItemUpdate(asPointer(query), asPointer(attrs))
          if (updateStatus !== ERR_SEC_SUCCESS) {
            throw new KeychainWriteError(`SecItemUpdate failed (OSStatus ${updateStatus})`)
          }
        } else if (status !== ERR_SEC_SUCCESS) {
          throw new KeychainWriteError(`SecItemAdd failed (OSStatus ${status})`)
        }
      } finally {
        release(created)
      }
    },
    find(service) {
      const svc = cfString(service)
      const acct = cfString(account)
      const query = cfDict([
        [kSecClass, kSecClassGenericPassword],
        [kSecAttrService, svc],
        [kSecAttrAccount, acct],
        [kSecReturnData, kCFBooleanTrue],
        [kSecMatchLimit, kSecMatchLimitOne],
      ])
      const result = new BigUint64Array(1)
      try {
        const status = security.symbols.SecItemCopyMatching(asPointer(query), ptr(result))
        if (status === ERR_SEC_ITEM_NOT_FOUND) {
          return null
        }
        if (status !== ERR_SEC_SUCCESS) {
          throw new KeychainUnavailableError(`SecItemCopyMatching failed (OSStatus ${status})`)
        }
        const dataRef = Number(result[0])
        if (!dataRef) {
          return null
        }
        const length = Number(cf.symbols.CFDataGetLength(asPointer(dataRef)))
        const bytePtr = cf.symbols.CFDataGetBytePtr(asPointer(dataRef))
        const value =
          length > 0 && bytePtr
            ? new TextDecoder().decode(
                new Uint8Array(toArrayBuffer(asPointer(Number(bytePtr)), 0, length)),
              )
            : ''
        cf.symbols.CFRelease(asPointer(dataRef))
        return value ? value : null
      } finally {
        release([svc, acct, query])
      }
    },
    remove(service) {
      const svc = cfString(service)
      const acct = cfString(account)
      const query = cfDict([
        [kSecClass, kSecClassGenericPassword],
        [kSecAttrService, svc],
        [kSecAttrAccount, acct],
      ])
      try {
        const status = security.symbols.SecItemDelete(asPointer(query))
        if (status !== ERR_SEC_SUCCESS && status !== ERR_SEC_ITEM_NOT_FOUND) {
          throw new KeychainWriteError(`SecItemDelete failed (OSStatus ${status})`)
        }
      } finally {
        release([svc, acct, query])
      }
    },
  }
}

// Compile-time build gate: buildCliBinary defines process.env.PRESS_TEST_BUILD
// as "0" (release) or "1" (hermetic test/e2e). Running from source leaves it unset.
function testBuildKeychainSeamEnabled(): boolean {
  return !process.env.PRESS_TEST_BUILD || process.env.PRESS_TEST_BUILD !== '0'
}

type SelectedStore = {
  readonly backend: Backend
  readonly reportAs: 'keychain' | 'file'
}

function loadFfiBackend(): Backend {
  if (ffiBackend === undefined) {
    try {
      ffiBackend = createFfiBackend()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new KeychainUnavailableError(`macOS keychain is unavailable: ${detail}`, {
        cause: error,
      })
    }
  }
  if (!ffiBackend) {
    throw new KeychainUnavailableError()
  }
  return ffiBackend
}

function selectStore(): SelectedStore {
  const testBuild = testBuildKeychainSeamEnabled()
  const seam = testBuild ? process.env.PRESS_E2E_KEYCHAIN_FILE : undefined
  const choice = chooseTokenStore({
    platform: process.platform,
    testBuild,
    ...(seam ? { testSeam: seam } : {}),
    keychainAvailable: process.platform === 'darwin',
  })
  if (choice === 'seam' && seam) {
    return { backend: fileBackend(seam), reportAs: 'keychain' }
  }
  if (choice === 'keychain') {
    try {
      return { backend: loadFfiBackend(), reportAs: 'keychain' }
    } catch (error) {
      if (error instanceof KeychainUnavailableError) {
        return { backend: fileBackend(resolveFileTokenPath()), reportAs: 'file' }
      }
      throw error
    }
  }
  return { backend: fileBackend(resolveFileTokenPath()), reportAs: 'file' }
}

function backend(): Backend {
  return selectStore().backend
}

export async function readCliToken(host: string): Promise<StoredCliToken | null> {
  const store = selectStore()
  const token = store.backend.find(serviceName(host))
  return token ? { kind: store.reportAs, token } : null
}

export async function readKeychainToken(host: string): Promise<string | null> {
  return (await readCliToken(host))?.token ?? null
}

// Store the token, then read it back and assert it round-trips so silent keychain
// truncation fails loudly instead of reporting a broken login as successful.
export async function writeKeychainToken(host: string, token: string): Promise<void> {
  if (!token) {
    throw new KeychainWriteError('refusing to store an empty token')
  }
  const active = backend()
  const service = serviceName(host)
  active.store(service, token)
  const stored = active.find(service)
  if (stored !== token) {
    throw new KeychainWriteError('keychain did not persist the token (read-back mismatch)')
  }
}

export async function removeKeychainToken(host: string): Promise<void> {
  backend().remove(serviceName(host))
}
