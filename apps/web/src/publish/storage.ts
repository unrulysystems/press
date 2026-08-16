import { closeSync, constants, createReadStream, fstatSync, open as openFile } from 'node:fs'
import { mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises'
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

// Open a served blob for reading, rejecting symlinks at the collection-directory
// and blob components (F-22) — the two components a local writer with
// PRESS_STORAGE_DIR access can tamper with. The storage dir itself and its
// ancestors are operator configuration, not this check's threat surface.
export async function openPageBlobForRead(
  storageDir: string,
  collectionSlug: CollectionSlug,
  fileSlug: FileSlug,
): Promise<ReadableStream<Uint8Array>> {
  const collectionDir = join(storageDir, collectionSlug)
  const path = join(collectionDir, fileSlug)

  // O_NOFOLLOW rejects a symlink at this component; O_DIRECTORY rejects a
  // non-directory. Open (not lstat) so a symlink fails the open itself rather than
  // a separate check an attacker can race.
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
      throw new Error(`stored page collection is not a real directory for ${collectionSlug}`)
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

    // Open the blob (final component) with O_NOFOLLOW | O_NONBLOCK via the callback
    // API for a raw descriptor owned by the stream's autoClose (no FileHandle GC
    // finalizer). O_NONBLOCK is load-bearing: a FIFO at this path would otherwise
    // block the open until a writer connects, before the non-regular-node check below
    // could ever run. O_NONBLOCK has no effect on regular-file reads.
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
        throw new Error(`stored page blob is not a regular file for ${collectionSlug}/${fileSlug}`)
      }
      throw error
    })
    const fileStat = fstatSync(fd)
    // Reject non-regular nodes (FIFO, device, socket): O_NOFOLLOW only rejects
    // symlinks, so a named pipe could otherwise become the served stream and block.
    if (!fileStat.isFile()) {
      throw new Error(`stored page blob is not a regular file for ${collectionSlug}/${fileSlug}`)
    }

    // Verify the collection directory was not swapped to a symlink between the dir
    // open and the blob open: stat() re-resolves the path (following any swap), so an
    // inode/device mismatch with the directory handle we opened means a race lost.
    // The blob itself is guarded by O_NOFOLLOW at open time; a concurrent republish
    // (rename over the blob) legitimately replaces it and must not read as tampering.
    //
    // Determinism / security waiver: an ABA swap — rename the genuine collection dir
    // aside, install a symlink to an external dir for the blob open, then restore the
    // genuine dir before this stat — passes the inode comparison while the descriptor
    // serves the external file. Closing it requires openat2(RESOLVE_NO_SYMLINKS), which
    // Node does not expose; this is a permanent exemption (removed by a native addon or
    // a storage layout that never shares the path namespace with untrusted writers).
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
