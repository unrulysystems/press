import { createRequire } from 'node:module'
import type cliPackage from '../package.json'

declare const PRESS_COMPILED_VERSION: string | undefined

function packageVersion(): string {
  const load = createRequire(import.meta.url)
  const metadata: typeof cliPackage = load('../package.json')
  return metadata.version
}

// Standalone builds embed package metadata; source and dual-module builds read
// the same package through Node's loader, which supports JSON in both formats.
export const CLI_VERSION =
  typeof PRESS_COMPILED_VERSION === 'string' ? PRESS_COMPILED_VERSION : packageVersion()
