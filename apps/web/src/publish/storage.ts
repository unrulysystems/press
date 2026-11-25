import { closeSync, constants, createReadStream, fstatSync, open as openFile } from 'node:fs'
import { link, mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'

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

async function fsyncPath(path: string): Promise<void> {
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
  await fsyncPath(sourceDirectory)
  if (destinationDirectory !== sourceDirectory) {
    await fsyncPath(destinationDirectory)
  }
}

// Open a served blob for reading, rejecting symlinks at the collection-directory
// and blob components. The storage dir itself and its ancestors are operator config.
export async function openPageBlobForRead(
  storageDir: string,
  collectionSlug: CollectionSlug,
  fileSlug: FileSlug,
): Promise<ReadableStream<Uint8Array>> {
  const collectionDir = join(storageDir, collectionSlug)
  const path = join(collectionDir, fileSlug)

  const dirHandle = await open(
    collectionDir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`stored page blob missing for ${collectionSlug}/${fileSlug}`, {
        cause: error,
      })
    }
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ELOOP' || error.code === 'ENOTDIR')
    ) {
      throw new Error(`stored page collection is not a real directory for ${collectionSlug}`, {
        cause: error,
      })
    }
    throw error
  })

  let fd: number | undefined
  let dirOpen = true
  const closeDir = async (): Promise<void> => {
    if (dirOpen) {
      dirOpen = false
      await dirHandle.close()
    }
  }
  try {
    const dirStat = await dirHandle.stat()

    // Open the blob with O_NOFOLLOW | O_NONBLOCK so symlinks fail at open and
    // a FIFO cannot block before the regular-file check below runs.
    fd = await new Promise<number>((resolve, reject) => {
      openFile(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        (error, descriptor) => {
          if (error) {
            reject(error)
          } else {
            resolve(descriptor)
          }
        },
      )
    }).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`stored page blob missing for ${collectionSlug}/${fileSlug}`, {
          cause: error,
        })
      }
      if (error instanceof Error && 'code' in error && error.code === 'ELOOP') {
        throw new Error(
          `stored page blob is not a regular file for ${collectionSlug}/${fileSlug}`,
          {
            cause: error,
          },
        )
      }
      throw error
    })
    const fileStat = fstatSync(fd)
    if (!fileStat.isFile()) {
      throw new Error(`stored page blob is not a regular file for ${collectionSlug}/${fileSlug}`)
    }

    // WAIVER(symlink-race-aba): An ABA swap (rename genuine collection dir aside,
    // install a symlink for the blob open, restore genuine dir before this stat)
    // passes the inode check. Closing it requires openat2(RESOLVE_NO_SYMLINKS),
    // which Node/Bun does not expose. Permanent — Node/Bun runtime lacks openat2.
    const parentStat = await stat(collectionDir)
    if (parentStat.ino !== dirStat.ino || parentStat.dev !== dirStat.dev) {
      throw new Error(`stored page collection changed while reading ${collectionSlug}/${fileSlug}`)
    }

    await closeDir()
    return Readable.toWeb(
      createReadStream(path, { fd, autoClose: true }),
    ) as unknown as ReadableStream<Uint8Array>
  } catch (error) {
    if (fd !== undefined) {
      closeSync(fd)
    }
    await closeDir()
    throw error
  }
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
  const handle = await open(
    tempPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  )
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
  let hadExisting = false

  try {
    // Hard-link the existing blob before overwriting so targetPath stays
    // continuously present for concurrent readers during atomic rename.
    await link(targetPath, rollbackPath)
    hadExisting = true
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }

  try {
    await rename(tempPath, targetPath)
    await fsyncPath(targetPath)
    await fsyncPath(directory)
  } catch (error) {
    if (hadExisting) {
      await rm(rollbackPath, { force: true }).catch(() => undefined)
    }
    throw error
  }

  return {
    async commit() {
      if (!hadExisting) {
        return
      }
      await unlink(rollbackPath)
      await fsyncPath(directory)
    },
    async rollback() {
      if (hadExisting) {
        await rename(rollbackPath, targetPath)
        await fsyncPath(targetPath)
      } else {
        await rm(targetPath, { force: true })
      }
      await fsyncPath(directory)
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
  await fsyncPath(dirname(sourcePath))
  await fsyncPath(dirname(targetPath))

  return {
    async commit() {},
    async rollback() {
      if (await exists(targetPath)) {
        await rename(targetPath, sourcePath)
        await fsyncPath(sourcePath)
        await fsyncPath(dirname(sourcePath))
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
    await fsyncPath(destinationPath)
    await fsyncMoveDirectories(sourcePath, destinationPath)
  } catch (error) {
    if (moved && (await exists(destinationPath))) {
      await rename(destinationPath, sourcePath)
      await fsyncPath(sourcePath)
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
      await fsyncPath(sourcePath)
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
