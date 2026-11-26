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

  test('destroys the connection and throws AggregateError when unlock fails', async () => {
    const events: string[] = []
    const connection = {
      async query(statement: string, values: readonly string[]) {
        const operation = statement.includes('pg_advisory_unlock') ? 'unlock' : 'lock'
        events.push(`${operation}:${values.join('/')}`)
        if (operation === 'unlock') {
          throw new Error('unlock connection lost')
        }
      },
      release(destroy?: boolean) {
        events.push(`release:${destroy === true ? 'destroy' : 'reuse'}`)
      },
    }
    const paths = [
      { collectionSlug: parseCollectionSlug('reports'), fileSlug: parseFileSlug('a.html') },
    ]

    const error = await withPagePathLocks(
      async () => connection,
      paths,
      async () => {
        throw new Error('operation failed')
      },
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(2)
    expect(events).toEqual(['lock:reports/a.html', 'unlock:reports/a.html', 'release:destroy'])
  })

  test('releases already-acquired locks when a later lock acquisition fails', async () => {
    const events: string[] = []
    let locksAcquired = 0
    const connection = {
      async query(statement: string, values: readonly string[]) {
        const operation = statement.includes('pg_advisory_unlock') ? 'unlock' : 'lock'
        events.push(`${operation}:${values.join('/')}`)
        if (operation === 'lock') {
          locksAcquired += 1
          if (locksAcquired === 2) {
            throw new Error('second lock failed')
          }
        }
      },
      release(destroy?: boolean) {
        events.push(`release:${destroy === true ? 'destroy' : 'reuse'}`)
      },
    }
    const paths = [
      { collectionSlug: parseCollectionSlug('a'), fileSlug: parseFileSlug('first.html') },
      { collectionSlug: parseCollectionSlug('b'), fileSlug: parseFileSlug('second.html') },
    ]

    await expect(
      withPagePathLocks(
        async () => connection,
        paths,
        async () => 'unreachable',
      ),
    ).rejects.toThrow('second lock failed')

    expect(events).toEqual([
      'lock:a/first.html',
      'lock:b/second.html',
      'unlock:a/first.html',
      'release:reuse',
    ])
  })
})
