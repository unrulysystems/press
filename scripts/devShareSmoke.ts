import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { localnetUsers } from '../apps/web/src/auth/localnetFixtures'
import { servedPageHeaders } from '../apps/web/src/publish/serveAcl'
import { pressCliExecutable } from './pressCliExecutable'

type CommandResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const root = resolve(import.meta.dirname, '..')
const pressBin = pressCliExecutable()
const defaultAgentEnvPath = resolve(root, '.dev/agent.env')
const smokeRun = Date.now().toString(36)
const collectionSlug = `dev-share-${smokeRun}`
const fileSlug = 'agent-smoke.html'

function fail(message: string): never {
  throw new Error(message)
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function parseEnvFile(raw: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const separator = trimmed.indexOf('=')
    if (separator === -1) {
      fail(`invalid env line in agent env file: ${trimmed}`)
    }
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1)
  }
  return values
}

function jsonLine(stdout: string): unknown {
  let line: string | undefined
  for (const item of stdout.split('\n')) {
    const trimmed = item.trim()
    if (trimmed) {
      line = trimmed
    }
  }
  if (!line) {
    fail('press CLI did not emit JSON')
  }
  return JSON.parse(line)
}

function runPress(args: readonly string[], env: Record<string, string>): Promise<CommandResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(pressBin, [...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('press CLI timed out after 30000ms'))
    }, 30_000)

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      resolveRun({ code: code ?? 1, stdout, stderr })
    })
  })
}

async function assertHumanSignIn(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: localnetUsers.owner.email,
      password: localnetUsers.owner.password,
      rememberMe: true,
    }),
  })
  const setCookie = response.headers.get('set-cookie') ?? ''
  if (response.status !== 200) {
    fail(`credential sign-in returned HTTP ${response.status}: ${await response.text()}`)
  }
  if (!setCookie.toLowerCase().includes('session')) {
    fail('credential sign-in did not set a session cookie')
  }
}

async function assertCliPublish(baseUrl: string, agentEnv: Record<string, string>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'press-dev-share-smoke-'))
  const reportPath = join(dir, fileSlug)
  const title = `Dev Share Smoke ${smokeRun}`
  await writeFile(reportPath, `<!doctype html><title>${title}</title><h1>${title}</h1>`)

  const env = {
    ...process.env,
    PRESS_TOKEN: agentEnv.PRESS_TOKEN,
  }
  delete env.PRESS_HOST

  const result = await runPress(
    [
      '--host',
      baseUrl,
      '--json',
      'publish',
      reportPath,
      '--to',
      collectionSlug,
      '--visibility',
      'public',
    ],
    env,
  )
  if (result.code !== 0) {
    fail(
      `press publish exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
  const body = jsonLine(result.stdout) as {
    readonly ok?: boolean
    readonly data?: { readonly url?: string }
  }
  const url = body.data?.url
  if (body.ok !== true || typeof url !== 'string') {
    fail(`press publish returned an invalid JSON envelope:\n${result.stdout}`)
  }

  const response = await fetch(url)
  if (response.status !== 200) {
    fail(`published page returned HTTP ${response.status}: ${url}`)
  }
  const csp = response.headers.get('content-security-policy')
  if (csp !== servedPageHeaders['Content-Security-Policy']) {
    fail(`published page CSP mismatch: ${csp ?? '<missing>'}`)
  }
  const html = await response.text()
  if (!html.includes(title)) {
    fail('published page body did not include the smoke title')
  }
}

const agentEnvPath = resolve(
  root,
  optionValue(process.argv.slice(2), '--env') ?? defaultAgentEnvPath,
)
const agentEnv = parseEnvFile(await readFile(agentEnvPath, 'utf8'))
const baseUrl = agentEnv.PRESS_URL
if (!baseUrl) {
  fail(`PRESS_URL missing from ${agentEnvPath}`)
}
if (!agentEnv.PRESS_TOKEN) {
  fail(`PRESS_TOKEN missing from ${agentEnvPath}`)
}

await assertHumanSignIn(baseUrl)
await assertCliPublish(baseUrl, agentEnv)
console.log(`press dev:share smoke passed for ${baseUrl}`)
