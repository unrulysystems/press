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

const binary = await buildCliBinary({
  platform: requestedPlatform,
  ...(optionValue(args, '--outfile') ? { outfile: optionValue(args, '--outfile') } : {}),
})
console.log(binary)
