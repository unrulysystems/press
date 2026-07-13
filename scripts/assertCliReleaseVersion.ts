import { CLI_PACKAGE_VERSION, assertReleaseVersion } from './cliRelease'

const tag = Bun.argv[2]
if (!tag) {
  throw new Error('release tag argument required')
}

console.log(assertReleaseVersion(tag, CLI_PACKAGE_VERSION))
