import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

// Acceptance surfaces share one override so CI/release rehearsals can point at
// an artifact explicitly without reintroducing source-entrypoint fallbacks.
export function pressCliExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.PRESS_CLI_PATH ?? resolve(root, 'artifacts/cli/press'))
}
