import { buildCliBinary, hostReleasePlatform, isReleasePlatform } from './cliRelease'

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const args = Bun.argv.slice(2)
const requestedPlatform = optionValue(args, '--platform') ?? hostReleasePlatform()
if (!isReleasePlatform(requestedPlatform)) {
  throw new Error(`unsupported release platform ${requestedPlatform}`)
}

// --release builds a seam-free binary (F-16): PRESS_E2E_KEYCHAIN_FILE has no
// effect in the shipped artifact. The default is the hermetic test/e2e build.
const releaseBuild = args.includes('--release')

const binary = await buildCliBinary({
  platform: requestedPlatform,
  testBuild: !releaseBuild,
  ...(optionValue(args, '--outfile') ? { outfile: optionValue(args, '--outfile') } : {}),
})
console.log(binary)
