import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertReleaseVersion,
  checksumFileContents,
  cliWorkspaceSourcePlugin,
  isPrereleaseVersion,
  packageCliBinary,
  releaseArchiveName,
  sha256File,
} from './cliRelease'

describe('CLI release contract', () => {
  test('requires the release tag to equal the package version', () => {
    expect(assertReleaseVersion('v0.2.0', '0.2.0')).toBe('0.2.0')
    expect(() => assertReleaseVersion('v0.2.1', '0.2.0')).toThrow(
      'release tag v0.2.1 does not match CLI package version 0.2.0',
    )
    expect(() => assertReleaseVersion('latest', '0.2.0')).toThrow('release tag must be v<semver>')
  })

  test('accepts only canonical SemVer release versions', () => {
    for (const version of ['0.2.0-alpha.1', '0.2.0-0A.is.legal', '0.2.0+build.01']) {
      expect(assertReleaseVersion(`v${version}`, version)).toBe(version)
      expect(releaseArchiveName(version, 'linux-x64')).toBe(`press-v${version}-linux-x64.tar.gz`)
    }

    for (const version of [
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.3-01',
      '1.2.3-..',
      '1.2.3-alpha..1',
      '1.2.3-alpha_1',
    ]) {
      expect(() => assertReleaseVersion(`v${version}`, version)).toThrow(
        'release tag must be v<semver>',
      )
      expect(() => releaseArchiveName(version, 'linux-x64')).toThrow(
        `invalid release version ${version}`,
      )
    }
  })

  test('classifies prerelease identifiers without confusing build metadata', () => {
    expect(isPrereleaseVersion('0.2.0-alpha.1')).toBe(true)
    expect(isPrereleaseVersion('0.2.0-alpha.1+build-1')).toBe(true)
    expect(isPrereleaseVersion('0.2.0')).toBe(false)
    expect(isPrereleaseVersion('0.2.0+build-1')).toBe(false)
  })

  test('names archives by version and platform', () => {
    expect(releaseArchiveName('0.2.0', 'macos-arm64')).toBe('press-v0.2.0-macos-arm64.tar.gz')
    expect(releaseArchiveName('0.2.0', 'linux-x64')).toBe('press-v0.2.0-linux-x64.tar.gz')
  })

  test('formats a portable SHA-256 checksum file', () => {
    expect(checksumFileContents('abc123', 'press-v0.2.0-linux-x64.tar.gz')).toBe(
      'abc123  press-v0.2.0-linux-x64.tar.gz\n',
    )
  })

  test('resolves workspace source without an installed workspace link', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'press-cli-workspace-source-test-'))
    try {
      const entrypoint = join(fixture, 'entrypoint.ts')
      await writeFile(
        entrypoint,
        "import { parseCollectionSlug } from '@press/core'\n" +
          "console.log(parseCollectionSlug('release-proof'))\n",
      )

      // The entrypoint lives outside the checkout, so normal package
      // resolution cannot walk into this repo's node_modules workspace links.
      const result = await Bun.build({
        entrypoints: [entrypoint],
        target: 'bun',
        packages: 'bundle',
        plugins: [cliWorkspaceSourcePlugin()],
      })
      expect(result.success).toBe(true)
      expect(result.logs).toEqual([])
      expect(await result.outputs[0]?.text()).toContain('release-proof')
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  test('normalizes archive metadata so a tag rerun is byte-stable', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'press-cli-release-test-'))
    try {
      const binary = join(fixture, 'press')
      await writeFile(binary, '#!/bin/sh\necho press\n')
      await chmod(binary, 0o755)

      const first = await packageCliBinary({ binary, outdir: join(fixture, 'first') })
      const second = await packageCliBinary({ binary, outdir: join(fixture, 'second') })
      expect(await sha256File(first.archive)).toBe(await sha256File(second.archive))

      const gzip = await readFile(first.archive)
      expect([...gzip.subarray(4, 8)]).toEqual([0, 0, 0, 0])

      const tarball = Buffer.from(Bun.gunzipSync(gzip))
      expect(tarball.subarray(0, 5).toString('ascii')).toBe('press')
      const mtime = tarball.subarray(136, 148).toString('ascii').split('\0', 1)[0]?.trim() ?? ''
      expect(Number.parseInt(mtime, 8)).toBe(0)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})
