import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import { parseCollectionSlug, parseFileSlug } from '@press/core'

import { moveBlob, openPageBlobForRead } from './storage'

const tempDirs: string[] = []

async function storageFixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'press-move-storage-'))
  tempDirs.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('openPageBlobForRead (F-22)', () => {
  const collection = parseCollectionSlug('readme')
  const file = parseFileSlug('page.html')

  test('streams a regular blob', async () => {
    const storageDir = await storageFixture()
    const directory = join(storageDir, collection)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, file), 'regular bytes')

    const stream = await openPageBlobForRead(storageDir, collection, file)
    expect(await new Response(stream).text()).toBe('regular bytes')
  })

  test('rejects a symlink instead of following it', async () => {
    const storageDir = await storageFixture()
    const directory = join(storageDir, collection)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'secret.txt'), 'not a report')
    await symlink(join(directory, 'secret.txt'), join(directory, file))

    await expect(openPageBlobForRead(storageDir, collection, file)).rejects.toThrow(
      'stored page blob is not a regular file',
    )
  })

  test('rejects a symlinked collection directory', async () => {
    const storageDir = await storageFixture()
    const outside = await storageFixture()
    await writeFile(join(outside, file), 'outside bytes')
    await symlink(outside, join(storageDir, collection))

    await expect(openPageBlobForRead(storageDir, collection, file)).rejects.toThrow(
      'stored page collection is not a real directory',
    )
  })

  test('rejects a FIFO without blocking (O_NONBLOCK)', async () => {
    const storageDir = await storageFixture()
    const directory = join(storageDir, collection)
    await mkdir(directory, { recursive: true })
    execFileSync('mkfifo', [join(directory, file)])

    await expect(openPageBlobForRead(storageDir, collection, file)).rejects.toThrow(
      'stored page blob is not a regular file',
    )
  })

  test('throws a clear error when the blob is missing', async () => {
    const storageDir = await storageFixture()
    await expect(openPageBlobForRead(storageDir, collection, file)).rejects.toThrow(
      'stored page blob missing',
    )
  })
})

describe('moveBlob', () => {
  const sourceCollection = parseCollectionSlug('source')
  const sourceFile = parseFileSlug('old.html')
  const destinationCollection = parseCollectionSlug('destination')
  const destinationFile = parseFileSlug('new.html')

  test('moves bytes and can roll back to the source path', async () => {
    const storageDir = await storageFixture()
    const sourcePath = join(storageDir, sourceCollection, sourceFile)
    const destinationPath = join(storageDir, destinationCollection, destinationFile)
    await mkdir(join(storageDir, sourceCollection), { recursive: true })
    await writeFile(sourcePath, 'original bytes')

    const move = await moveBlob(
      storageDir,
      sourceCollection,
      sourceFile,
      destinationCollection,
      destinationFile,
    )

    expect(await readFile(destinationPath, 'utf8')).toBe('original bytes')
    await expect(readFile(sourcePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await move.rollback()
    expect(await readFile(sourcePath, 'utf8')).toBe('original bytes')
    await expect(readFile(destinationPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('never overwrites destination bytes', async () => {
    const storageDir = await storageFixture()
    const sourcePath = join(storageDir, sourceCollection, sourceFile)
    const destinationPath = join(storageDir, destinationCollection, destinationFile)
    await mkdir(join(storageDir, sourceCollection), { recursive: true })
    await mkdir(join(storageDir, destinationCollection), { recursive: true })
    await writeFile(sourcePath, 'source bytes')
    await writeFile(destinationPath, 'destination bytes')

    await expect(
      moveBlob(storageDir, sourceCollection, sourceFile, destinationCollection, destinationFile),
    ).rejects.toThrow('destination blob already exists')
    expect(await readFile(sourcePath, 'utf8')).toBe('source bytes')
    expect(await readFile(destinationPath, 'utf8')).toBe('destination bytes')
  })
})
