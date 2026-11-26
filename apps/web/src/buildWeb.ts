import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const dist = resolve(root, 'apps/web/dist')
const MAX_WALK_DEPTH = 16

const env = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? 'production',
  ONE_SERVER_URL: process.env.ONE_SERVER_URL ?? 'http://127.0.0.1:4174',
}

async function findDevelopmentArtifacts(directory: string, depth = 0): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) {
    throw new Error(`dist directory exceeded max walk depth (${MAX_WALK_DEPTH}): ${directory}`)
  }
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        return findDevelopmentArtifacts(path, depth + 1)
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
