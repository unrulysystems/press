import cliPackage from '../package.json' with { type: 'json' }

// Package metadata is bundled into standalone executables, so the runtime never
// needs a checkout while source and release versions still have one owner.
export const CLI_VERSION = cliPackage.version
