#!/usr/bin/env bun

import { PAGE_REDIRECT_MODES, parseCollectionSlug, parseFileSlug } from '@press/core'

import type { PageRedirectMode } from '@press/core'

import {
  KeychainUnavailableError,
  KeychainWriteError,
  readKeychainToken,
  removeKeychainToken,
  writeKeychainToken,
} from './keychain'
import { readPagePassword } from './pagePassword'
import { formatPublishOutput } from './publishOutput'

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

async function findKeychainToken(host: string): Promise<string | null> {
  return await readKeychainToken(host).catch((error: unknown) => {
    if (error instanceof KeychainUnavailableError) {
      return null
    }
    throw error
  })
}

async function storeKeychainToken(host: string, token: string): Promise<void> {
  await writeKeychainToken(host, token).catch((error: unknown) => {
    if (error instanceof KeychainUnavailableError) {
      throw new CliError('macOS keychain unavailable: set PRESS_TOKEN for this host instead')
    }
    if (error instanceof KeychainWriteError) {
      throw new CliError(error.message)
    }
    throw error
  })
}

async function deleteKeychainToken(host: string): Promise<void> {
  await removeKeychainToken(host)
}

async function resolveToken(host: string): Promise<TokenSource | null> {
  const keychainToken = await findKeychainToken(host)
  if (keychainToken) {
    return { kind: 'keychain', token: keychainToken }
  }
  const envToken = process.env.PRESS_TOKEN?.trim()
  return envToken ? { kind: 'env', token: envToken } : null
}

type WhoamiProbe =
  | { readonly ok: true; readonly email: string | null }
  | { readonly ok: false; readonly error: string }

type DoctorReport = {
  readonly host: string
  readonly tokenSource: 'keychain' | 'env' | 'none'
  readonly authenticated: boolean
  readonly email: string | null
  readonly nextStep: string | null
  readonly detail: string | null
}

// Pure report builder so `press doctor` can be unit-tested without the macOS
// keychain or a live server. `commandDoctor` supplies the resolved token source
// and the whoami probe result; this decides the human-facing verdict + guidance.
export function buildDoctorReport(input: {
  readonly host: string
  readonly tokenSource: 'keychain' | 'env' | 'none'
  readonly whoami: WhoamiProbe | null
}): DoctorReport {
  const { host, tokenSource, whoami } = input
  if (tokenSource === 'none') {
    return {
      host,
      tokenSource,
      authenticated: false,
      email: null,
      nextStep: authRequiredGuidance,
      detail: null,
    }
  }
  if (whoami?.ok) {
    return {
      host,
      tokenSource,
      authenticated: true,
      email: whoami.email,
      nextStep: null,
      detail: null,
    }
  }
  // A token is present but the server rejected it or was unreachable.
  return {
    host,
    tokenSource,
    authenticated: false,
    email: null,
    nextStep:
      'token was rejected: run "press login" again, or set a valid PRESS_TOKEN for this host',
    detail: whoami ? whoami.error : null,
  }
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

const authRequiredGuidance =
  'authentication required: run "press login" for interactive use, ' +
  'or set PRESS_TOKEN and PRESS_HOST for agents. Run "press doctor" to check.'

async function requireToken(ctx: CliContext): Promise<TokenSource> {
  const source = await resolveToken(ctx.host)
  if (!source) {
    throw new CliError(authRequiredGuidance, 2)
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

export function parseMoveArguments(args: readonly string[]): {
  readonly source: { readonly collection: string; readonly file: string }
  readonly destination: { readonly collection: string; readonly file: string }
  readonly redirect: PageRedirectMode
} {
  const positional = stripOptions(args, ['--redirect'])
  if (positional.length !== 2) {
    throw new CliError('move requires <source> <destination>')
  }
  const [rawSource, rawDestination] = positional
  if (!rawSource || !rawDestination) {
    throw new CliError('move requires <source> <destination>')
  }
  const rawRedirect = optionValue(args, '--redirect') ?? 'permanent'
  if (!(PAGE_REDIRECT_MODES as readonly string[]).includes(rawRedirect)) {
    throw new CliError(`redirect must be one of ${PAGE_REDIRECT_MODES.join(', ')}`)
  }
  const source = parseTarget(rawSource)
  const destination = parseTarget(rawDestination)
  if (source.collection === destination.collection && source.file === destination.file) {
    throw new CliError('destination must differ from source')
  }
  return {
    source,
    destination,
    redirect: rawRedirect as PageRedirectMode,
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

export function createLoopbackCallbackHandler(input: {
  readonly state: string
  readonly resolveCode: (code: string) => void
}): (request: Request) => Response {
  return (request) => {
    const url = new URL(request.url)
    if (url.pathname !== '/callback') {
      return new Response('not found', { status: 404 })
    }
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    if (state !== input.state || !code) {
      return new Response('press login rejected\n', {
        status: 400,
        headers: { 'content-type': 'text/plain' },
      })
    }
    input.resolveCode(code)
    return new Response('press login complete\n', {
      headers: { 'content-type': 'text/plain' },
    })
  }
}

async function commandLogin(ctx: CliContext, args: readonly string[]): Promise<void> {
  const noOpen = hasFlag(args, '--no-open') || process.env.PRESS_NO_BROWSER === '1'
  const verifier = randomBase64Url(32)
  const challenge = sha256Base64Url(verifier)
  const state = randomBase64Url(32)

  let resolveCode: (code: string) => void
  const codePromise = new Promise<string>((resolve) => {
    resolveCode = resolve
  })

  const fetch = createLoopbackCallbackHandler({
    state,
    resolveCode: (code) => {
      resolveCode(code)
    },
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch,
  })
  if (!server.port) {
    server.stop(true)
    throw new CliError('failed to start loopback listener')
  }

  const authorizeUrl = `${ctx.host}/cli/authorize?port=${server.port}&challenge=${encodeURIComponent(challenge)}&state=${encodeURIComponent(state)}`
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

async function commandDoctor(ctx: CliContext): Promise<void> {
  const source = await resolveToken(ctx.host)
  const tokenSource = source?.kind ?? 'none'
  let whoami: WhoamiProbe | null = null
  if (source) {
    try {
      const body = (await apiFetch(ctx, '/api/cli/whoami', { token: source.token })) as JsonRecord
      const email =
        body.user && typeof body.user === 'object' && 'email' in body.user
          ? String(body.user.email)
          : null
      whoami = { ok: true, email }
    } catch (error) {
      whoami = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const report = buildDoctorReport({ host: ctx.host, tokenSource, whoami })
  if (ctx.json) {
    printSuccess(ctx, { ...report })
    return
  }
  console.log(`host:          ${report.host}`)
  console.log(`token source:  ${report.tokenSource}`)
  console.log(
    `authenticated: ${report.authenticated ? `yes${report.email ? ` (${report.email})` : ''}` : 'no'}`,
  )
  if (report.detail) {
    console.log(`detail:        ${report.detail}`)
  }
  if (report.nextStep) {
    console.log(`next step:     ${report.nextStep}`)
  }
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
  const [filePath] = stripFlags(stripOptions(args, ['--to', '--as', '--visibility', '--allow']), [
    '--password',
  ])
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
  const wantsPassword = hasFlag(args, '--password')
  // `--password` without an explicit visibility implies a password-protected page.
  const visibility = optionValue(args, '--visibility') ?? (wantsPassword ? 'password' : undefined)
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
  const headers: Record<string, string> = { 'content-type': 'text/html' }
  if (wantsPassword) {
    // Acquired out-of-band and sent as a header — never argv/query/logs (INV-4).
    headers['x-press-page-password'] = await readPagePassword()
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : ''
  const body = (await apiFetch(ctx, `/api/pages/${collectionSlug}/${fileSlug}${suffix}`, {
    method: 'PUT',
    token: source.token,
    headers,
    body: html,
  })) as JsonRecord
  if (ctx.json) {
    printSuccess(ctx, body)
    return
  }
  for (const line of formatPublishOutput(body)) {
    console.log(line)
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
  const [target] = stripFlags(stripOptions(args, ['--visibility', '--allow']), ['--password'])
  if (!target) {
    throw new CliError('page set requires <collection>/<file>')
  }
  const { collection, file } = parseTarget(target)
  const visibility = optionValue(args, '--visibility')
  const allow = optionValue(args, '--allow')
  const wantsPassword = hasFlag(args, '--password')
  if (!visibility && allow === undefined && !wantsPassword) {
    throw new CliError('page set requires --visibility, --allow, or --password')
  }
  const source = await requireToken(ctx)
  let body: JsonRecord = {}
  if (visibility || allow !== undefined) {
    body = (await apiFetch(ctx, `/api/pages/${collection}/${file}`, {
      method: 'PATCH',
      token: source.token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(visibility ? { visibility } : {}),
        ...(allow !== undefined ? { allowlist: allow.split(',').map((item) => item.trim()) } : {}),
      }),
    })) as JsonRecord
  }
  if (wantsPassword) {
    // Set a custom password (and flip the page to visibility=password) via the
    // re-roll endpoint; the password travels in a header, never argv/query (INV-4).
    body = (await apiFetch(ctx, `/api/pages/${collection}/${file}/password`, {
      method: 'POST',
      token: source.token,
      headers: { 'x-press-page-password': await readPagePassword() },
    })) as JsonRecord
  }
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

type MoveResponse = {
  readonly source: { readonly url: string }
  readonly destination: { readonly url: string }
  readonly redirect: PageRedirectMode
} & JsonRecord

async function commandMove(ctx: CliContext, args: readonly string[]): Promise<void> {
  const input = parseMoveArguments(args)
  const source = await requireToken(ctx)
  const body = (await apiFetch(
    ctx,
    `/api/pages/${input.source.collection}/${input.source.file}/move`,
    {
      method: 'POST',
      token: source.token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        collection: input.destination.collection,
        file: input.destination.file,
        redirect: input.redirect,
      }),
    },
  )) as MoveResponse
  if (ctx.json) {
    printSuccess(ctx, body)
    return
  }
  if (typeof body.source?.url !== 'string' || typeof body.destination?.url !== 'string') {
    throw new CliError('move returned an invalid response')
  }
  console.log(`from:     ${body.source.url}`)
  console.log(`to:       ${body.destination.url}`)
  console.log(`redirect: ${body.redirect}`)
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
    case 'doctor':
      await commandDoctor(ctx)
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
    case 'move':
      await commandMove(ctx, presentStrings([subcommand, ...rest]))
      return
    default:
      throw new CliError(
        'usage: press <login|logout|whoami|doctor|publish|list|page set|unpublish|move>',
      )
  }
}

if (import.meta.main) {
  void run(Bun.argv.slice(2))
    .then(() => {
      process.exit(0)
    })
    .catch((error) => {
      process.exit(printError(Bun.argv.includes('--json'), error))
    })
}
