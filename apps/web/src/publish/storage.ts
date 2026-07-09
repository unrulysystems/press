import { constants } from 'node:fs'
import { mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { CollectionSlug, FileSlug } from '@press/core'

type BlobInstall = {
  readonly commit: () => Promise<void>
  readonly rollback: () => Promise<void>
}

function blobPath(storageDir: string, collectionSlug: CollectionSlug, fileSlug: FileSlug): string {
  return join(storageDir, collectionSlug, fileSlug)
}

function archivePath(
  storageDir: string,
  collectionSlug: CollectionSlug,
  fileSlug: FileSlug,
): string {
  const archiveName = `${Date.now()}-${crypto.randomUUID()}-${fileSlug}`
  return join(storageDir, '.archive', collectionSlug, archiveName)
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function fsyncDir(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function fsyncMoveDirectories(sourcePath: string, destinationPath: string): Promise<void> {
  const sourceDirectory = dirname(sourcePath)
  const destinationDirectory = dirname(destinationPath)
  await fsyncDir(sourceDirectory)
  if (destinationDirectory !== sourceDirectory) {
    await fsyncDir(destinationDirectory)
  }
}

export function pageBlobPath(
  storageDir: string,
  collectionSlug: CollectionSlug,
  fileSlug: FileSlug,
): string {
  return blobPath(storageDir, collectionSlug, fileSlug)
}

export async function writeTempBlob(
  storageDir: string,
  collectionSlug: CollectionSlug,
  fileSlug: FileSlug,
  body: Uint8Array,
): Promise<string> {
  const directory = join(storageDir, collectionSlug)
  await mkdir(directory, { recursive: true })
  const tempPath = join(directory, `.${fileSlug}.${crypto.randomUUID()}.tmp`)
  const handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY)
  try {
    await handle.writeFile(body)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return tempPath
}

export async function installBlob(
  storageDir: string,
  collectionSlug: CollectionSlug,
  fileSlug: FileSlug,
  tempPath: string,
): Promise<BlobInstall> {
  const targetPath = blobPath(storageDir, collectionSlug, fileSlug)
  const directory = dirname(targetPath)
  await mkdir(directory, { recursive: true })
  const rollbackPath = join(directory, `.${fileSlug}.${crypto.randomUUID()}.rollback`)
  const hadExisting = await exists(targetPath)

  if (hadExisting) {
    await rename(targetPath, rollbackPath)
  }

  await rename(tempPath, targetPath)
  await fsyncFile(targetPath)
  await fsyncDir(directory)

  return {
    async commit() {
      if (!hadExisting) {
        return
      }
      await unlink(rollbackPath)
      await fsyncDir(directory)
    },
    async rollback() {
      await rm(targetPath, { force: true })
      if (hadExisting) {
        await rename(rollbackPath, targetPath)
        await fsyncFile(targetPath)
      }
      await fsyncDir(directory)
    },
  }
}

export async function removeTempBlob(path: string): Promise<void> {
  await rm(path, { force: true })
}

export async function archiveBlob(
  storageDir: string,
  collectionSlug: CollectionSlug,
  fileSlug: FileSlug,
): Promise<BlobInstall> {
  const sourcePath = blobPath(storageDir, collectionSlug, fileSlug)
  const targetPath = archivePath(storageDir, collectionSlug, fileSlug)
  await mkdir(dirname(targetPath), { recursive: true })
  await rename(sourcePath, targetPath)
  await fsyncDir(dirname(sourcePath))
  await fsyncDir(dirname(targetPath))

  return {
    async commit() {},
    async rollback() {
      if (await exists(targetPath)) {
        await rename(targetPath, sourcePath)
        await fsyncFile(sourcePath)
        await fsyncDir(dirname(sourcePath))
      }
    },
  }
}

export async function moveBlob(
  storageDir: string,
  sourceCollectionSlug: CollectionSlug,
  sourceFileSlug: FileSlug,
  destinationCollectionSlug: CollectionSlug,
  destinationFileSlug: FileSlug,
): Promise<BlobInstall> {
  const sourcePath = blobPath(storageDir, sourceCollectionSlug, sourceFileSlug)
  const destinationPath = blobPath(storageDir, destinationCollectionSlug, destinationFileSlug)
  if (await exists(destinationPath)) {
    throw new Error(
      `destination blob already exists for ${destinationCollectionSlug}/${destinationFileSlug}`,
    )
  }

  await mkdir(dirname(destinationPath), { recursive: true })
  let moved = false
  try {
    await rename(sourcePath, destinationPath)
    moved = true
    await fsyncFile(destinationPath)
    await fsyncMoveDirectories(sourcePath, destinationPath)
  } catch (error) {
    if (moved && (await exists(destinationPath))) {
      await rename(destinationPath, sourcePath)
      await fsyncFile(sourcePath)
      await fsyncMoveDirectories(destinationPath, sourcePath)
    }
    throw error
  }

  return {
    async commit() {},
    async rollback() {
      if (!(await exists(destinationPath))) {
        throw new Error(
          `cannot roll back missing destination blob ${destinationCollectionSlug}/${destinationFileSlug}`,
        )
      }
      if (await exists(sourcePath)) {
        throw new Error(
          `cannot roll back over existing source blob ${sourceCollectionSlug}/${sourceFileSlug}`,
        )
      }
      await rename(destinationPath, sourcePath)
      await fsyncFile(sourcePath)
      await fsyncMoveDirectories(destinationPath, sourcePath)
    },
  }
}

export async function removeBlob(
  storageDir: string,
  collectionSlug: CollectionSlug,
  fileSlug: FileSlug,
): Promise<void> {
  await unlink(blobPath(storageDir, collectionSlug, fileSlug))
}
