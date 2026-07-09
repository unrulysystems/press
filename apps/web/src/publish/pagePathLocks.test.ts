import { describe, expect, test } from 'bun:test'
import { parseCollectionSlug, parseFileSlug } from '@press/core'

import { sortPagePathsForLock, withPagePathLocks } from './pagePathLocks'

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

describe('withPagePathLocks', () => {
  test('retains both locks until failed work finishes compensation', async () => {
    const events: string[] = []
    const connection = {
      async query(statement: string, values: readonly string[]) {
        const operation = statement.includes('pg_advisory_unlock') ? 'unlock' : 'lock'
        events.push(`${operation}:${values.join('/')}`)
      },
      release(destroy?: boolean) {
        events.push(`release:${destroy === true ? 'destroy' : 'reuse'}`)
      },
    }
    const paths = [
      {
        collectionSlug: parseCollectionSlug('ab'),
        fileSlug: parseFileSlug('c.html'),
      },
      {
        collectionSlug: parseCollectionSlug('a'),
        fileSlug: parseFileSlug('bc.html'),
      },
    ]

    await expect(
      withPagePathLocks(
        async () => connection,
        paths,
        async () => {
          events.push('transaction:rollback')
          await Promise.resolve()
          events.push('blob:rollback')
          throw new Error('forced transaction failure')
        },
      ),
    ).rejects.toThrow('forced transaction failure')

    expect(events).toEqual([
      'lock:a/bc.html',
      'lock:ab/c.html',
      'transaction:rollback',
      'blob:rollback',
      'unlock:ab/c.html',
      'unlock:a/bc.html',
      'release:reuse',
    ])
  })
})
