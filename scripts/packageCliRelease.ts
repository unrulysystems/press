import {
  CLI_PACKAGE_VERSION,
  defaultCliBinary,
  hostReleasePlatform,
  isReleasePlatform,
  packageCliBinary,
} from './cliRelease'

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const args = Bun.argv.slice(2)
const requestedPlatform = optionValue(args, '--platform') ?? hostReleasePlatform()
if (!isReleasePlatform(requestedPlatform)) {
  throw new Error(`unsupported release platform ${requestedPlatform}`)
}

const artifacts = await packageCliBinary({
  binary: optionValue(args, '--binary') ?? defaultCliBinary,
  platform: requestedPlatform,
  version: optionValue(args, '--version') ?? CLI_PACKAGE_VERSION,
  ...(optionValue(args, '--outdir') ? { outdir: optionValue(args, '--outdir') } : {}),
})
console.log(artifacts.archive)
console.log(artifacts.checksumFile)
