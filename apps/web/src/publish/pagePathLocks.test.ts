import { describe, expect, test } from 'bun:test'
import { parseCollectionSlug, parseFileSlug } from '@press/core'

import { sortPagePathsForLock } from './pagePathLocks'

describe('sortPagePathsForLock', () => {
  test('orders collision-shaped valid paths identically regardless of request order', () => {
    const first = {
      collectionSlug: parseCollectionSlug('a'),
      fileSlug: parseFileSlug('bc.html'),
    }
    const second = {
      collectionSlug: parseCollectionSlug('ab'),
      fileSlug: parseFileSlug('c.html'),
    }

    expect(sortPagePathsForLock([first, second])).toEqual([first, second])
    expect(sortPagePathsForLock([second, first])).toEqual([first, second])
  })

  test('does not mutate caller order', () => {
    const paths = [
      {
        collectionSlug: parseCollectionSlug('z'),
        fileSlug: parseFileSlug('last.html'),
      },
      {
        collectionSlug: parseCollectionSlug('a'),
        fileSlug: parseFileSlug('first.html'),
      },
    ]
    const original = [...paths]

    sortPagePathsForLock(paths)

    expect(paths).toEqual(original)
  })
})
