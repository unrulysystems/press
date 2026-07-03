#!/usr/bin/env bun

import { parseCollectionSlug, parseFileSlug } from '@press/core'

type JsonRecord = Record<string, unknown>

type CliContext = {
  readonly host: string
  readonly json: boolean
}

type TokenSource =
  | { readonly kind: 'keychain'; readonly token: string }
  | { readonly kind: 'env'; readonly token: string }

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 | 3 = 1,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

const account = 'token'

function normalizeHost(raw: string | undefined): string {
  const value = raw?.trim()
  if (!value) {
    throw new CliError('host required: pass --host or set PRESS_HOST')
  }
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new CliError('host must use http or https')
    }
    return url.toString().replace(/\/$/, '')
  } catch (error) {
    if (error instanceof CliError) {
      throw error
    }
    throw new CliError('host must be a valid URL')
  }
}

function sha256Base64Url(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('base64url')
}

function randomBase64Url(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes))
  let binary = ''
  for (const byte of data) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function serviceName(host: string): string {
  return `press:${host}`
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return ''
  }
  return await new Response(stream).text()
}

async function runSecurity(
  args: readonly string[],
  input?: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn(['security', ...args], {
    stdin: input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (input !== undefined) {
    child.stdin.write(input)
    child.stdin.end()
  }
  const [stdout, stderr, code] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    child.exited,
  ])
  return { code, stdout, stderr }
}

async function findKeychainToken(host: string): Promise<string | null> {
  const result = await runSecurity([
    'find-generic-password',
    '-s',
    serviceName(host),
    '-a',
    account,
    '-w',
  ])
  if (result.code !== 0) {
    return null
  }
  const token = result.stdout.trim()
  return token || null
}

async function storeKeychainToken(host: string, token: string): Promise<void> {
  const result = await runSecurity(
    ['add-generic-password', '-U', '-s', serviceName(host), '-a', account, '-w'],
    token,
  )
  if (result.code !== 0) {
    throw new CliError('failed to store token in keychain')
  }
}

async function deleteKeychainToken(host: string): Promise<void> {
  await runSecurity(['delete-generic-password', '-s', serviceName(host), '-a', account])
}

async function resolveToken(host: string): Promise<TokenSource | null> {
  const keychainToken = await findKeychainToken(host)
  if (keychainToken) {
    return { kind: 'keychain', token: keychainToken }
  }
  const envToken = process.env.PRESS_TOKEN?.trim()
  return envToken ? { kind: 'env', token: envToken } : null
}

function printSuccess(ctx: CliContext, data: JsonRecord): void {
  if (ctx.json) {
    console.log(JSON.stringify({ ok: true, data }))
    return
  }
  if (typeof data.message === 'string') {
    console.log(data.message)
  }
}

function printError(json: boolean, error: unknown): 1 | 2 | 3 {
  const cliError =
    error instanceof CliError
      ? error
      : new CliError(error instanceof Error ? error.message : String(error))
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { message: cliError.message } }))
  } else {
    console.error(cliError.message)
  }
  return cliError.exitCode
}

async function apiFetch(
  ctx: CliContext,
  path: string,
  init: RequestInit & { readonly token?: string } = {},
): Promise<unknown> {
  const headers = new Headers(init.headers)
  if (init.token) {
    headers.set('authorization', `Bearer ${init.token}`)
  }
  const response = await fetch(`${ctx.host}${path}`, {
    ...init,
    headers,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `request failed with HTTP ${response.status}`
    if (response.status === 401) {
      throw new CliError(message, 2)
    }
    if (response.status === 403) {
      throw new CliError(message, 3)
    }
    throw new CliError(message)
  }
  return body
}

async function requireToken(ctx: CliContext): Promise<TokenSource> {
  const source = await resolveToken(ctx.host)
  if (!source) {
    throw new CliError('authentication required: run press login', 2)
  }
  return source
}

function parseTarget(target: string): { readonly collection: string; readonly file: string } {
  const [collection, file, extra] = target.split('/')
  if (!collection || !file || extra) {
    throw new CliError('target must be <collection>/<file>')
  }
  return {
    collection: parseCollectionSlug(collection),
    file: parseFileSlug(file),
  }
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) {
    return undefined
  }
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    throw new CliError(`${name} requires a value`)
  }
  return value
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name)
}

function stripOptions(args: readonly string[], names: readonly string[]): string[] {
  const out: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) {
      continue
    }
    if (names.includes(arg)) {
      index += 1
      continue
    }
    out.push(arg)
  }
  return out
}

function stripFlags(args: readonly string[], names: readonly string[]): string[] {
  return args.filter((arg) => !names.includes(arg))
}

function presentStrings(args: readonly (string | undefined)[]): string[] {
  return args.filter((arg): arg is string => Boolean(arg))
}

function deriveFileSlug(path: string): string {
  const filename = path.split(/[\\/]/).at(-1) ?? ''
  return parseFileSlug(filename.trim().toLowerCase().replaceAll(/\s+/g, '-'))
}

async function commandLogin(ctx: CliContext, args: readonly string[]): Promise<void> {
  const noOpen = hasFlag(args, '--no-open') || process.env.PRESS_NO_BROWSER === '1'
  const verifier = randomBase64Url(32)
  const challenge = sha256Base64Url(verifier)

  let resolveCode: (code: string) => void
  let rejectCode: (error: Error) => void
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      try {
        const url = new URL(request.url)
        if (url.pathname !== '/callback') {
          return new Response('not found', { status: 404 })
        }
        const code = url.searchParams.get('code')
        if (!code) {
          throw new Error('authorization code missing')
        }
        resolveCode(code)
        return new Response('press login complete\n', {
          headers: { 'content-type': 'text/plain' },
        })
      } catch (error) {
        rejectCode(error instanceof Error ? error : new Error(String(error)))
        return new Response('press login failed\n', {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        })
      }
    },
  })
  if (!server.port) {
    server.stop(true)
    throw new CliError('failed to start loopback listener')
  }

  const authorizeUrl = `${ctx.host}/cli/authorize?port=${server.port}&challenge=${encodeURIComponent(challenge)}`
  if (noOpen) {
    if (ctx.json) {
      console.log(
        JSON.stringify({ ok: true, data: { status: 'authorization-required', authorizeUrl } }),
      )
    } else {
      console.log(authorizeUrl)
    }
  } else {
    Bun.spawn(['open', authorizeUrl], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }).unref()
  }

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new CliError('login timed out')), 120_000).unref()
  })

  try {
    const code = await Promise.race([codePromise, timeout])
    const exchanged = (await apiFetch(ctx, '/api/cli/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, verifier }),
    })) as { readonly token?: string; readonly user?: { readonly email?: string } }
    if (!exchanged.token || !exchanged.user?.email) {
      throw new CliError('login exchange returned an invalid response')
    }
    await storeKeychainToken(ctx.host, exchanged.token)
    printSuccess(ctx, {
      message: `logged in as ${exchanged.user.email}`,
      user: exchanged.user,
      authorizeUrl,
    })
  } finally {
    server.stop(true)
  }
}

async function commandWhoami(ctx: CliContext): Promise<void> {
  const source = await requireToken(ctx)
  const body = (await apiFetch(ctx, '/api/cli/whoami', { token: source.token })) as JsonRecord
  printSuccess(ctx, {
    message:
      body.user && typeof body.user === 'object' && 'email' in body.user
        ? String(body.user.email)
        : 'authenticated',
    ...body,
  })
}

async function commandLogout(ctx: CliContext): Promise<void> {
  const source = await requireToken(ctx)
  await apiFetch(ctx, '/api/cli/logout', {
    method: 'POST',
    token: source.token,
  })
  if (source.kind === 'keychain') {
    await deleteKeychainToken(ctx.host)
  }
  printSuccess(ctx, { message: 'logged out' })
}

async function commandPublish(ctx: CliContext, args: readonly string[]): Promise<void> {
  const [filePath] = stripOptions(args, ['--to', '--as', '--visibility', '--allow'])
  if (!filePath) {
    throw new CliError('publish requires a file path')
  }
  const collection = optionValue(args, '--to')
  if (!collection) {
    throw new CliError('publish requires --to <collection>')
  }
  const fileSlug = optionValue(args, '--as') ?? deriveFileSlug(filePath)
  const collectionSlug = parseCollectionSlug(collection)
  parseFileSlug(fileSlug)
  const visibility = optionValue(args, '--visibility')
  const allow = optionValue(args, '--allow')
  const query = new URLSearchParams()
  if (visibility) {
    query.set('visibility', visibility)
  }
  if (allow) {
    query.set('allow', allow)
  }
  const source = await requireToken(ctx)
  const html = await Bun.file(filePath)
    .arrayBuffer()
    .catch(() => {
      throw new CliError(`failed to read ${filePath}`)
    })
  const suffix = query.size > 0 ? `?${query.toString()}` : ''
  const body = (await apiFetch(ctx, `/api/pages/${collectionSlug}/${fileSlug}${suffix}`, {
    method: 'PUT',
    token: source.token,
    headers: { 'content-type': 'text/html' },
    body: html,
  })) as JsonRecord
  if (ctx.json) {
    printSuccess(ctx, body)
    return
  }
  console.log(String(body.url))
  if (typeof body.password === 'string') {
    console.log(`password: ${body.password}`)
  }
}

async function commandList(ctx: CliContext, args: readonly string[]): Promise<void> {
  const source = await requireToken(ctx)
  const [collection] = args
  const body = (await apiFetch(
    ctx,
    collection ? `/api/collections/${collection}/pages` : '/api/collections',
    {
      token: source.token,
    },
  )) as JsonRecord
  if (ctx.json) {
    printSuccess(ctx, body)
    return
  }
  const entries = Array.isArray(body.pages)
    ? body.pages.map(
        (entry) => `${entry.collection}/${entry.file}\t${entry.visibility}\t${entry.title}`,
      )
    : Array.isArray(body.collections)
      ? body.collections.map((entry) => `${entry.slug}\t${entry.defaultVisibility}`)
      : []
  console.log(entries.join('\n'))
}

async function commandPageSet(ctx: CliContext, args: readonly string[]): Promise<void> {
  const [target] = stripOptions(args, ['--visibility', '--allow'])
  if (!target) {
    throw new CliError('page set requires <collection>/<file>')
  }
  const { collection, file } = parseTarget(target)
  const visibility = optionValue(args, '--visibility')
  const allow = optionValue(args, '--allow')
  if (!visibility && allow === undefined) {
    throw new CliError('page set requires --visibility or --allow')
  }
  const source = await requireToken(ctx)
  const body = (await apiFetch(ctx, `/api/pages/${collection}/${file}`, {
    method: 'PATCH',
    token: source.token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(visibility ? { visibility } : {}),
      ...(allow !== undefined ? { allowlist: allow.split(',').map((item) => item.trim()) } : {}),
    }),
  })) as JsonRecord
  printSuccess(ctx, { message: `${collection}/${file} updated`, ...body })
}

async function commandUnpublish(ctx: CliContext, args: readonly string[]): Promise<void> {
  const [target] = args
  if (!target) {
    throw new CliError('unpublish requires <collection>/<file>')
  }
  const { collection, file } = parseTarget(target)
  const source = await requireToken(ctx)
  await apiFetch(ctx, `/api/pages/${collection}/${file}`, {
    method: 'DELETE',
    token: source.token,
  })
  printSuccess(ctx, { message: `${collection}/${file} unpublished` })
}

async function run(argv: readonly string[]): Promise<void> {
  const json = hasFlag(argv, '--json')
  const host = normalizeHost(optionValue(argv, '--host') ?? process.env.PRESS_HOST)
  const withoutGlobals = stripFlags(stripOptions(argv, ['--host']), ['--json'])
  const [command, subcommand, ...rest] = withoutGlobals
  const ctx = { host, json }

  switch (command) {
    case 'login':
      await commandLogin(ctx, presentStrings([subcommand, ...rest]))
      return
    case 'logout':
      await commandLogout(ctx)
      return
    case 'whoami':
      await commandWhoami(ctx)
      return
    case 'publish':
      await commandPublish(ctx, presentStrings([subcommand, ...rest]))
      return
    case 'list':
      await commandList(ctx, presentStrings([subcommand, ...rest]))
      return
    case 'page':
      if (subcommand !== 'set') {
        throw new CliError('usage: press page set <collection>/<file>')
      }
      await commandPageSet(ctx, rest)
      return
    case 'unpublish':
      await commandUnpublish(ctx, presentStrings([subcommand, ...rest]))
      return
    default:
      throw new CliError('usage: press <login|logout|whoami|publish|list|page set|unpublish>')
  }
}

void run(Bun.argv.slice(2))
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    process.exit(printError(Bun.argv.includes('--json'), error))
  })
