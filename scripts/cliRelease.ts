import { spawnSync } from 'node:child_process'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import cliPackage from '../packages/cli/package.json' with { type: 'json' }

const root = resolve(import.meta.dirname, '..')
const numericIdentifier = '(?:0|[1-9]\\d*)'
const nonNumericIdentifier = '(?:\\d*[A-Za-z-][0-9A-Za-z-]*)'
const prereleaseIdentifier = `(?:${numericIdentifier}|${nonNumericIdentifier})`
const buildIdentifier = '[0-9A-Za-z-]+'
const semverPattern = new RegExp(
  `^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}` +
    `(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?` +
    `(?:\\+${buildIdentifier}(?:\\.${buildIdentifier})*)?$`,
)

export const RELEASE_TARGETS = {
  'macos-arm64': {
    bunTarget: 'bun-darwin-arm64',
    os: 'darwin',
    arch: 'arm64',
    runner: 'macos-15',
  },
  'linux-x64': {
    bunTarget: 'bun-linux-x64',
    os: 'linux',
    arch: 'x64',
    runner: 'ubuntu-24.04',
  },
} as const satisfies Record<
  string,
  {
    readonly bunTarget: Bun.Build.Target
    readonly os: NodeJS.Platform
    readonly arch: NodeJS.Architecture
    readonly runner: string
  }
>

export type ReleasePlatform = keyof typeof RELEASE_TARGETS

export const CLI_PACKAGE_VERSION = cliPackage.version
export const defaultCliBinary = resolve(root, 'artifacts/cli/press')
export const defaultReleaseDirectory = resolve(root, 'artifacts/release')

export function cliWorkspaceSourcePlugin(): Bun.BunPlugin {
  const coreSource = resolve(root, 'packages/core/src/index.ts')
  return {
    name: 'press-cli-workspace-sources',
    setup(build) {
      // A standalone release must not depend on an installer's workspace-link
      // layout. Nub can validly install every external dependency while a
      // concurrent clean CI install omits the @press/core symlink, so resolve
      // the CLI's own package boundary to its canonical source explicitly.
      build.onResolve({ filter: /^@press\/core$/ }, () => ({ path: coreSource }))
    },
  }
}

function fail(message: string): never {
  throw new Error(message)
}

export function isReleasePlatform(value: string): value is ReleasePlatform {
  return Object.hasOwn(RELEASE_TARGETS, value)
}

export function hostReleasePlatform(
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): ReleasePlatform {
  const match = Object.entries(RELEASE_TARGETS).find(
    ([, target]) => target.os === platform && target.arch === architecture,
  )?.[0]
  if (!match || !isReleasePlatform(match)) {
    return fail(`unsupported release host ${platform}-${architecture}`)
  }
  return match
}

export function assertNativeReleasePlatform(platform: ReleasePlatform): void {
  const target = RELEASE_TARGETS[platform]
  if (target.os !== process.platform || target.arch !== process.arch) {
    fail(
      `release platform ${platform} requires native ${target.os}-${target.arch}, ` +
        `got ${process.platform}-${process.arch}`,
    )
  }
}

export function assertReleaseVersion(tag: string, packageVersion: string): string {
  const taggedVersion = tag.startsWith('v') ? tag.slice(1) : ''
  if (!semverPattern.test(taggedVersion)) {
    return fail('release tag must be v<semver>')
  }
  if (taggedVersion !== packageVersion) {
    return fail(`release tag ${tag} does not match CLI package version ${packageVersion}`)
  }
  return taggedVersion
}

export function isPrereleaseVersion(version: string): boolean {
  if (!semverPattern.test(version)) {
    return fail(`invalid release version ${version}`)
  }
  const buildMetadataStart = version.indexOf('+')
  const precedence = buildMetadataStart === -1 ? version : version.slice(0, buildMetadataStart)
  return precedence.includes('-')
}

export function releaseArchiveName(version: string, platform: ReleasePlatform): string {
  if (!semverPattern.test(version)) {
    return fail(`invalid release version ${version}`)
  }
  return `press-v${version}-${platform}.tar.gz`
}

export function checksumFileContents(checksum: string, filename: string): string {
  return `${checksum}  ${filename}\n`
}

export async function sha256File(file: string): Promise<string> {
  const contents = await readFile(file)
  return new Bun.CryptoHasher('sha256').update(contents).digest('hex')
}

export async function buildCliBinary(
  input: {
    readonly platform?: ReleasePlatform
    readonly outfile?: string
  } = {},
): Promise<string> {
  const platform = input.platform ?? hostReleasePlatform()
  assertNativeReleasePlatform(platform)
  const outfile = resolve(input.outfile ?? defaultCliBinary)
  await mkdir(dirname(outfile), { recursive: true })
  await rm(outfile, { force: true })

  const result = await Bun.build({
    entrypoints: [resolve(root, 'packages/cli/src/index.ts')],
    compile: {
      target: RELEASE_TARGETS[platform].bunTarget,
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadPackageJson: false,
      autoloadTsconfig: false,
    },
    minify: true,
    packages: 'bundle',
    plugins: [cliWorkspaceSourcePlugin()],
  })
  if (!result.success) {
    const detail = result.logs.map((entry) => entry.message).join('\n')
    return fail(`standalone CLI build failed${detail ? `:\n${detail}` : ''}`)
  }
  await chmod(outfile, 0o755)
  return outfile
}

function tar(input: readonly string[], cwd = root): string {
  const result = spawnSync('tar', [...input], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  if (result.status !== 0) {
    return fail(`tar ${input.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout
}

export async function packageCliBinary(input: {
  readonly binary: string
  readonly platform?: ReleasePlatform
  readonly outdir?: string
  readonly version?: string
}): Promise<{ readonly archive: string; readonly checksumFile: string }> {
  const platform = input.platform ?? hostReleasePlatform()
  assertNativeReleasePlatform(platform)
  const version = input.version ?? CLI_PACKAGE_VERSION
  const outdir = resolve(input.outdir ?? defaultReleaseDirectory)
  const archive = join(outdir, releaseArchiveName(version, platform))
  const checksumFile = `${archive}.sha256`
  const stage = await mkdtemp(join(tmpdir(), 'press-cli-release-'))
  await mkdir(outdir, { recursive: true })

  try {
    const stagedBinary = join(stage, 'press')
    const uncompressedArchive = join(stage, 'press.tar')
    await copyFile(resolve(input.binary), stagedBinary)
    await chmod(stagedBinary, 0o755)
    // A release retry for one immutable tag must reproduce the same bytes. The
    // binary content is already fixed by the commit; normalize the only
    // per-invocation file metadata before archiving it.
    await utimes(stagedBinary, new Date(0), new Date(0))
    await rm(archive, { force: true })
    await rm(checksumFile, { force: true })
    tar(['--format', 'ustar', '-cf', uncompressedArchive, '-C', stage, 'press'])

    // gzip -n writes neither the staging path nor the current timestamp into
    // the header. Both Apple gzip and GNU gzip support this portable flag.
    const archiveHandle = await open(archive, 'w')
    let gzipFailure: string | undefined
    try {
      const result = spawnSync('gzip', ['-n', '-9', '-c', uncompressedArchive], {
        encoding: 'utf8',
        env: process.env,
        stdio: ['ignore', archiveHandle.fd, 'pipe'],
      })
      if (result.status !== 0) {
        gzipFailure = `gzip failed: ${result.stderr.trim()}`
      }
    } finally {
      await archiveHandle.close()
    }
    if (gzipFailure) {
      await rm(archive, { force: true })
      return fail(gzipFailure)
    }

    const entries = tar(['-tzf', archive])
      .split('\n')
      .map((entry) => entry.trim().replace(/^\.\//, ''))
      .filter(Boolean)
    if (entries.length !== 1 || entries[0] !== 'press') {
      return fail(
        `release archive must contain only root executable press; got ${entries.join(', ')}`,
      )
    }

    const checksum = await sha256File(archive)
    await writeFile(checksumFile, checksumFileContents(checksum, basename(archive)))
    return { archive, checksumFile }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
