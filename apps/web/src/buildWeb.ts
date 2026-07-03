import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const dist = resolve(root, 'apps/web/dist')

const env = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? 'production',
  ONE_SERVER_URL: process.env.ONE_SERVER_URL ?? 'http://127.0.0.1:4174',
  PRESS_BASE_URL: process.env.PRESS_BASE_URL ?? 'http://127.0.0.1:4174',
  PRESS_ALLOWED_DOMAINS: process.env.PRESS_ALLOWED_DOMAINS ?? 'send.it',
  PRESS_ADMIN_EMAILS: process.env.PRESS_ADMIN_EMAILS ?? 'admin@send.it',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://press:press@127.0.0.1:54329/press',
  PRESS_STORAGE_DIR: process.env.PRESS_STORAGE_DIR ?? resolve(root, '.press/build/storage'),
  // Build-time config import requires this value; runtime still requires a real secret.
  BETTER_AUTH_SECRET:
    process.env.BETTER_AUTH_SECRET ?? 'build-placeholder-better-auth-secret-at-least-32-bytes',
  PRESS_ENABLE_CREDENTIAL_AUTH: process.env.PRESS_ENABLE_CREDENTIAL_AUTH ?? '0',
  PRESS_MAX_UPLOAD_BYTES: process.env.PRESS_MAX_UPLOAD_BYTES ?? `${25 * 1024 * 1024}`,
  // Build-time production config validation requires this value; it is not used for OAuth.
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? 'build-placeholder',
  // Paired with GOOGLE_CLIENT_ID for config validation only; runtime still validates real OAuth env.
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? 'build-placeholder',
}

async function findDevelopmentArtifacts(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        return findDevelopmentArtifacts(path)
      }
      return entry.isFile() && entry.name.endsWith('.development.js') ? [path] : []
    }),
  )
  return nested.flat()
}

async function verifyProductionBuild(): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    throw new Error(`build:web must run with NODE_ENV=production, got "${env.NODE_ENV}"`)
  }

  const developmentArtifacts = await findDevelopmentArtifacts(dist)
  if (developmentArtifacts.length > 0) {
    throw new Error(
      [
        'build:web produced development React artifacts:',
        ...developmentArtifacts.map((path) => `- ${path}`),
      ].join('\n'),
    )
  }
}

const child = spawn('one', ['build', '--platform=web'], {
  env,
  stdio: 'inherit',
})

child.on('error', (error) => {
  console.error(error.message)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`one build terminated by ${signal}`)
    process.exit(1)
  }
  if (code !== 0) {
    process.exit(code ?? 1)
  }
  verifyProductionBuild()
    .then(() => {
      process.exit(0)
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
})
