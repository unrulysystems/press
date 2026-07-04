import { randomBytes, timingSafeEqual } from 'node:crypto'

// Minimum length for a publisher-supplied custom page password (REQ-PUB-005 / F3).
// Security > ergonomics: a memorable password still may not be trivially short.
// Server-generated passwords are always well above this.
export const MIN_PAGE_PASSWORD_LENGTH = 8

// Pure strength check for a publisher-supplied password. Trimmed length only —
// surrounding whitespace does not count toward the minimum.
export function isStrongPagePassword(password: string): boolean {
  return password.trim().length >= MIN_PAGE_PASSWORD_LENGTH
}

const ARGON2_MEMORY_KIB = 19_456
const ARGON2_PASSES = 2
const ARGON2_PARALLELISM = 1
const ARGON2_TAG_LENGTH = 32

function phcBase64(value: Buffer): string {
  return value.toString('base64').replaceAll('=', '')
}

function parsePhcBase64(value: string): Buffer {
  return Buffer.from(value, 'base64')
}

function parseArgon2idHash(hash: string): {
  readonly memory: number
  readonly passes: number
  readonly parallelism: number
  readonly salt: Buffer
  readonly tag: Buffer
} | null {
  const parts = hash.split('$')
  if (parts.length !== 6 || parts[1] !== 'argon2id' || parts[2] !== 'v=19') {
    return null
  }
  const params = new Map(
    (parts[3] ?? '').split(',').map((entry) => {
      const [key, value] = entry.split('=')
      return [key, Number(value)] as const
    }),
  )
  const memory = params.get('m')
  const passes = params.get('t')
  const parallelism = params.get('p')
  if (!memory || !passes || !parallelism) {
    return null
  }
  const salt = parsePhcBase64(parts[4] ?? '')
  const tag = parsePhcBase64(parts[5] ?? '')
  if (salt.byteLength === 0 || tag.byteLength === 0) {
    return null
  }
  return { memory, passes, parallelism, salt, tag }
}

type NativeArgon2 = (
  algorithm: 'argon2id',
  options: {
    readonly message: string
    readonly nonce: Buffer
    readonly parallelism: number
    readonly tagLength: number
    readonly memory: number
    readonly passes: number
  },
  callback: (error: Error | null, derivedKey: Buffer) => void,
) => void

async function deriveArgon2id(input: {
  readonly password: string
  readonly salt: Buffer
  readonly memory: number
  readonly passes: number
  readonly parallelism: number
  readonly tagLength: number
}): Promise<Buffer> {
  const crypto = (await import('node:crypto')) as typeof import('node:crypto') & {
    readonly argon2?: NativeArgon2
  }
  if (!crypto.argon2) {
    throw new Error('node:crypto argon2 unavailable')
  }

  return await new Promise<Buffer>((resolve, reject) => {
    crypto.argon2(
      'argon2id',
      {
        message: input.password,
        nonce: input.salt,
        parallelism: input.parallelism,
        tagLength: input.tagLength,
        memory: input.memory,
        passes: input.passes,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error)
          return
        }
        resolve(derivedKey)
      },
    )
  })
}

export async function hashPagePassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  let tag: Buffer
  try {
    tag = await deriveArgon2id({
      password,
      salt,
      parallelism: ARGON2_PARALLELISM,
      tagLength: ARGON2_TAG_LENGTH,
      memory: ARGON2_MEMORY_KIB,
      passes: ARGON2_PASSES,
    })
  } catch (error) {
    if (typeof Bun === 'undefined') {
      throw error
    }
    return await Bun.password.hash(password, 'argon2id')
  }

  return `$argon2id$v=19$m=${ARGON2_MEMORY_KIB},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}$${phcBase64(salt)}$${phcBase64(tag)}`
}

export async function verifyPagePassword(password: string, hash: string): Promise<boolean> {
  if (typeof Bun !== 'undefined') {
    try {
      if (await Bun.password.verify(password, hash)) {
        return true
      }
    } catch {
      return false
    }
  }

  const parsed = parseArgon2idHash(hash)
  if (!parsed) {
    return false
  }
  const candidate = await deriveArgon2id({
    password,
    salt: parsed.salt,
    memory: parsed.memory,
    passes: parsed.passes,
    parallelism: parsed.parallelism,
    tagLength: parsed.tag.byteLength,
  }).catch(() => null)
  if (!candidate) {
    return false
  }
  return candidate.byteLength === parsed.tag.byteLength && timingSafeEqual(candidate, parsed.tag)
}
