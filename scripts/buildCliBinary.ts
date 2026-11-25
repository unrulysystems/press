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

// Default to a seam-free release binary; test/e2e builds opt in explicitly with --test-build.
const testBuild = args.includes('--test-build') && !args.includes('--release')
const outfile = optionValue(args, '--outfile')

const binary = await buildCliBinary({
  platform: requestedPlatform,
  testBuild,
  ...(outfile ? { outfile } : {}),
})
console.log(binary)
