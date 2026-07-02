import { argon2, randomBytes } from 'node:crypto'

const ARGON2_MEMORY_KIB = 19_456
const ARGON2_PASSES = 2
const ARGON2_PARALLELISM = 1
const ARGON2_TAG_LENGTH = 32

function phcBase64(value: Buffer): string {
  return value.toString('base64').replaceAll('=', '')
}

export async function hashPagePassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const tag = await new Promise<Buffer>((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: password,
        nonce: salt,
        parallelism: ARGON2_PARALLELISM,
        tagLength: ARGON2_TAG_LENGTH,
        memory: ARGON2_MEMORY_KIB,
        passes: ARGON2_PASSES,
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

  return `$argon2id$v=19$m=${ARGON2_MEMORY_KIB},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}$${phcBase64(salt)}$${phcBase64(tag)}`
}
