import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { dlopen, FFIType as T, ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi'

// Per-host token storage for the `press` CLI (REQ-AUTH-006: OS keychain first, then PRESS_TOKEN).
//
// Why not shell out to `security add-generic-password … -w`? Empirically, `security -w` reads the
// value from the controlling terminal (`/dev/tty`), NOT piped stdin — so in a non-TTY shell it
// stores an EMPTY password and still exits 0 (issue #7: silent false "logged in"). The only inline
// alternative, `-w <value>`, puts the secret in argv (forbidden by the secret-handling rule). So the
// store path binds the macOS Keychain Services API directly via bun:ffi: the token travels as a
// CFData in-process — no argv, no TTY — which works headless and lets us fail closed by reading the
// value back after writing.

// Keep this long enough that CoreFoundation allocates a normal CFString. Very short strings can be
// tagged pointers above JS's precise integer range; Bun's current `ptr` FFI args cannot pass those
// BigInt-exact, which breaks cross-process Keychain lookups.
const account = 'press-cli-token'

function serviceName(host: string): string {
  return `press:${host}`
}

export class KeychainUnavailableError extends Error {
  constructor(message = 'macOS keychain is unavailable') {
    super(message)
    this.name = 'KeychainUnavailableError'
  }
}

export class KeychainWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeychainWriteError'
  }
}

type Backend = {
  readonly store: (service: string, token: string) => void
  readonly find: (service: string) => string | null
  readonly remove: (service: string) => void
}

// ---- File backend: the faithful test/harness seam ----------------------------------------------
// A JSON file named by PRESS_E2E_KEYCHAIN_FILE stands in for the OS keychain so a real `press login`
// round-trips a real token in hermetic tests without touching the operator's keychain (which would
// trip a biometric/Boundary prompt). It mirrors the real backend's contract: reject empty, round-trip
// non-empty, missing => null. (The old PATH-shadowed `security` stub read stdin — which real
// `security -w` never does — so it masked issue #7. This in-process seam cannot drift that way.)
type FileState = Record<string, string>

function readFileState(file: string): FileState {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as FileState
  } catch {
    return {}
  }
}

function fileBackend(file: string): Backend {
  const key = (service: string): string => `${service}:${account}`
  const persist = (state: FileState): void => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
    chmodSync(file, 0o600)
  }
  return {
    store(service, token) {
      const state = readFileState(file)
      state[key(service)] = token
      persist(state)
    },
    find(service) {
      const value = readFileState(file)[key(service)]
      return value ? value : null
    },
    remove(service) {
      const state = readFileState(file)
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
  // dlopen/dlsym from libSystem so we can read Security/CoreFoundation *data* symbols (the kSec*/kCF*
  // constants are `const CFStringRef` globals — bun:ffi's dlopen resolves functions, not data). dlsym
  // returns the variable's address; deref once to get the CFxxxRef pointer the APIs compare by value.
  const libc = dlopen(LIBSYSTEM, {
    dlopen: { args: [T.ptr, T.i32], returns: T.ptr },
    dlsym: { args: [T.ptr, T.ptr], returns: T.ptr },
  })
  const cstrPtr = (value: string): Pointer => ptr(cstr(value))
  const RTLD_NOW = 2
  const cfHandle = Number(libc.symbols.dlopen(cstrPtr(CORE_FOUNDATION), RTLD_NOW))
  const secHandle = Number(libc.symbols.dlopen(cstrPtr(SECURITY), RTLD_NOW))
  if (!cfHandle || !secHandle) {
    throw new KeychainUnavailableError('failed to load Security.framework')
  }
  const constRef = (handle: number, name: string): number => {
    const addr = Number(libc.symbols.dlsym(asPointer(handle), cstrPtr(name)))
    if (!addr) {
      throw new KeychainUnavailableError(`missing keychain constant ${name}`)
    }
    return Number(read.ptr(asPointer(addr), 0))
  }
  // A callbacks-struct constant is passed BY ADDRESS (it is the struct, not a pointer to it).
  const structAddr = (handle: number, name: string): number => {
    const addr = Number(libc.symbols.dlsym(asPointer(handle), cstrPtr(name)))
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
          // Item exists: update its data (mirrors the old `-U` upsert).
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
        if (status === ERR_SEC_ITEM_NOT_FOUND || status !== ERR_SEC_SUCCESS) {
          return null
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

// Compile-time build gate (F-16): buildCliBinary defines
// process.env.PRESS_TEST_BUILD as the literal "1" (hermetic test/e2e binaries)
// or "0" (release binaries). Running from source (unit tests) leaves it unset,
// which keeps the seam enabled. A runtime environment value can never change
// the compiled decision.
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
      const unavailable = new KeychainUnavailableError(`macOS keychain is unavailable: ${detail}`)
      if (error instanceof Error && error.stack) {
        unavailable.stack = error.stack
      }
      throw unavailable
    }
  }
  if (!ffiBackend) {
    throw new KeychainUnavailableError()
  }
  return ffiBackend
}

// Resolve the active backend: the file seam wins when PRESS_E2E_KEYCHAIN_FILE is
// set (test builds only), else the macOS FFI backend, else the last-resort 0600
// XDG file store. The seam reports as keychain so hermetic tests stay a stand-in
// for the OS store (F-16).
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
    } catch {
      return { backend: fileBackend(resolveFileTokenPath()), reportAs: 'file' }
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

// Store the token, then read it back and assert it round-trips. `security -w`/misconfigured stores
// can persist an empty or truncated value and still "succeed"; the readback converts any such silent
// failure into a loud one (issue #7) so `press login` never reports success on an unusable token.
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
