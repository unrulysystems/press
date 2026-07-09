import type { CollectionSlug, FileSlug } from '@press/core'

export type PagePathLock = {
  readonly collectionSlug: CollectionSlug
  readonly fileSlug: FileSlug
}

type PagePathLockConnection = {
  query(statement: string, values: string[]): Promise<unknown>
  release(destroy?: boolean): void
}

const LOCK_PAGE_PATH = 'select pg_advisory_lock(hashtext($1), hashtext($2))'
const UNLOCK_PAGE_PATH = 'select pg_advisory_unlock(hashtext($1), hashtext($2))'

function compareSlug(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

// Return a fresh array because callers should not have their request-order data
// mutated merely to establish the database's lock acquisition order.
export function sortPagePathsForLock(paths: readonly PagePathLock[]): PagePathLock[] {
  const sorted = [...paths]
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target lacks Array#toSorted.
  sorted.sort((left, right) => {
    // Slugs are validated ASCII. Compare the tuple fields directly so no
    // locale collation rule can erase a separator and collapse distinct paths.
    const collectionOrder = compareSlug(left.collectionSlug, right.collectionSlug)
    return collectionOrder || compareSlug(left.fileSlug, right.fileSlug)
  })
  return sorted
}

export async function withPagePathLocks<Connection extends PagePathLockConnection, Result>(
  connect: () => Promise<Connection>,
  paths: readonly PagePathLock[],
  operation: (connection: Connection) => Promise<Result>,
): Promise<Result> {
  const connection = await connect()
  const locked: PagePathLock[] = []
  let outcome:
    | { readonly ok: true; readonly value: Result }
    | { readonly ok: false; error: unknown }

  try {
    for (const path of sortPagePathsForLock(paths)) {
      // Session locks deliberately outlive a failed transaction so filesystem
      // compensation finishes before another mutation can acquire either path.
      // oxlint-disable-next-line no-await-in-loop
      await connection.query(LOCK_PAGE_PATH, [path.collectionSlug, path.fileSlug])
      locked.push(path)
    }
    outcome = { ok: true, value: await operation(connection) }
  } catch (error) {
    outcome = { ok: false, error }
  }

  const releaseErrors: unknown[] = []
  for (let index = locked.length - 1; index >= 0; index -= 1) {
    const path = locked[index]
    if (!path) {
      continue
    }
    try {
      // Reverse release mirrors acquisition and keeps teardown deterministic.
      // oxlint-disable-next-line no-await-in-loop
      await connection.query(UNLOCK_PAGE_PATH, [path.collectionSlug, path.fileSlug])
    } catch (error) {
      releaseErrors.push(error)
    }
  }

  const destroy = releaseErrors.length > 0
  try {
    // A connection with an uncertain advisory-lock state must never return to
    // the pool; destroying it lets PostgreSQL release every session lock.
    connection.release(destroy)
  } catch (error) {
    releaseErrors.push(error)
  }

  if (releaseErrors.length > 0) {
    throw new AggregateError(
      outcome.ok ? releaseErrors : [outcome.error, ...releaseErrors],
      'page path lock release failed',
    )
  }
  if (!outcome.ok) {
    throw outcome.error
  }
  return outcome.value
}
