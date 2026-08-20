import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { findServeResources, findUnsupervisedServeResources } from './tiltSupervision'

const repoRoot = resolve(import.meta.dir, '..')

/** Tiltfiles this repo owns. Vendored extensions supervise on our behalf. */
const OWNED_TILTFILES = ['Tiltfile', 'tilt/localnet.Tiltfile'] as const

describe('Starlark serve_cmd scanning', () => {
  test('flags a bare local_resource that serves', () => {
    const found = findUnsupervisedServeResources(
      "local_resource('web', serve_cmd='nub run dev', labels=['press'])",
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ callee: 'local_resource', name: 'web', line: 1 })
  })

  test('accepts a janitor-wrapped serve resource', () => {
    expect(
      findUnsupervisedServeResources("janitor_local_resource('web', serve_cmd='nub run dev')"),
    ).toEqual([])
  })

  test('ignores one-shot resources that only run cmd', () => {
    expect(findServeResources("local_resource('migrate', cmd='nub run db:migrate')")).toEqual([])
  })

  test('does not read serve_cmd out of a string or a comment', () => {
    expect(findServeResources("local_resource('x', cmd='echo serve_cmd=1')")).toEqual([])
    expect(findServeResources("# local_resource('x', serve_cmd='y')\n")).toEqual([])
  })

  test('does not mistake a nested call keyword for the outer resource', () => {
    expect(findServeResources("local_resource('x', cmd=helper(serve_cmd='y'))")).toHaveLength(1)
    expect(findServeResources("local_resource('x', cmd=helper(serve_cmd='y'))")[0]).toMatchObject({
      callee: 'helper',
    })
  })

  test('reports the call line for multi-line and multi-resource files', () => {
    const source = [
      "local_resource('one', cmd='a')",
      'local_resource(',
      "    'two',",
      "    serve_cmd='b',",
      ')',
    ].join('\n')
    const found = findUnsupervisedServeResources(source)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ name: 'two', line: 2 })
  })

  test('tolerates triple-quoted strings and escapes', () => {
    expect(findServeResources(`local_resource('x', cmd='''serve_cmd='no' ''')`)).toEqual([])
    expect(findServeResources(`local_resource('x', cmd='it\\'s serve_cmd=no')`)).toEqual([])
  })
})

describe('every long-running dev server in this repo is supervised', () => {
  test.each(OWNED_TILTFILES)('%s has no unsupervised serve_cmd', async (relativePath) => {
    const source = await readFile(join(repoRoot, relativePath), 'utf8')
    const unsupervised = findUnsupervisedServeResources(source)
    const detail = unsupervised
      .map(
        (resource) =>
          `${relativePath}:${resource.line} ${resource.callee}(${resource.name ?? '?'})`,
      )
      .join('\n')
    expect(
      unsupervised,
      `serve_cmd without janitor supervision reparents to init when Tilt dies:\n${detail}`,
    ).toEqual([])
  })
})
