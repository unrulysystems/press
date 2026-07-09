import type { CollectionSlug, FileSlug } from '@press/core'

export type PagePathLock = {
  readonly collectionSlug: CollectionSlug
  readonly fileSlug: FileSlug
}

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
