import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import { parseCollectionSlug, parseFileSlug } from '@press/core'

import { moveBlob } from './storage'

const tempDirs: string[] = []

async function storageFixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'press-move-storage-'))
  tempDirs.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
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
