import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import { servedPageHeaders } from '../apps/web/src/publish/serveAcl'

type SmokeEnv = NodeJS.ProcessEnv & Record<string, string>

type CommandResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const root = resolve(import.meta.dirname, '..')
const composeFile = resolve(root, 'compose.yaml')
const imageName = process.env.PRESS_IMAGE_NAME ?? 'press-web:local'
const projectName = `press-image-smoke-${process.pid}`
const networkName = `${projectName}_default`
const appContainer = `${projectName}-web`
const smokeBasePort = Number(process.env.PRESS_SMOKE_PORT ?? 49174)
const postgresPort = `${smokeBasePort + 1}`
const webPort = `${smokeBasePort + 2}`
const baseUrl = `http://127.0.0.1:${webPort}`
const requiredCsp = servedPageHeaders['Content-Security-Policy']

function fail(message: string): never {
  throw new Error(message)
}

function assertIncludes(haystack: string, needle: string, context: string): void {
  if (!haystack.includes(needle)) {
    fail(`${context}: expected output to include "${needle}", got:\n${haystack}`)
  }
}

function localnetHostEnv(storageDir: string): SmokeEnv {
  return {
    ...process.env,
    NODE_ENV: 'development',
    PRESS_PORT: webPort,
    PRESS_POSTGRES_PORT: postgresPort,
    PRESS_BASE_URL: baseUrl,
    PRESS_ALLOWED_DOMAINS: 'send.it',
    PRESS_ADMIN_EMAILS: 'admin@send.it',
    DATABASE_URL: `postgres://press:press@127.0.0.1:${postgresPort}/press`,
    PRESS_STORAGE_DIR: storageDir,
    BETTER_AUTH_SECRET: 'localnet-secret-at-least-32-bytes',
    PRESS_ENABLE_CREDENTIAL_AUTH: '1',
    PRESS_MAX_UPLOAD_BYTES: `${25 * 1024 * 1024}`,
  }
}

function localnetContainerEnv(): Record<string, string> {
  return {
    NODE_ENV: 'development',
    PRESS_PORT: '4174',
    PRESS_BASE_URL: baseUrl,
    PRESS_ALLOWED_DOMAINS: 'send.it',
    PRESS_ADMIN_EMAILS: 'admin@send.it',
    DATABASE_URL: 'postgres://press:press@postgres:5432/press',
    PRESS_STORAGE_DIR: '/data/press-storage',
    BETTER_AUTH_SECRET: 'localnet-secret-at-least-32-bytes',
    PRESS_ENABLE_CREDENTIAL_AUTH: '1',
    PRESS_MAX_UPLOAD_BYTES: `${25 * 1024 * 1024}`,
  }
}

function productionCredentialRefusalEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    PRESS_BASE_URL: 'https://press.example.test',
    PRESS_ALLOWED_DOMAINS: 'send.it',
    PRESS_ADMIN_EMAILS: 'admin@send.it',
    DATABASE_URL: 'postgres://press:press@127.0.0.1:1/press',
    PRESS_STORAGE_DIR: '/tmp/press-storage',
    BETTER_AUTH_SECRET: 'localnet-secret-at-least-32-bytes',
    GOOGLE_CLIENT_ID: 'build-placeholder',
    GOOGLE_CLIENT_SECRET: 'build-placeholder',
    PRESS_ENABLE_CREDENTIAL_AUTH: '1',
    PRESS_MAX_UPLOAD_BYTES: `${25 * 1024 * 1024}`,
  }
}

function redactCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ')
}

function run(
  command: string,
  args: readonly string[],
  options: {
    readonly env?: SmokeEnv
    readonly timeoutMs?: number
    readonly input?: string
    readonly inherit?: boolean
    readonly allowFailure?: boolean
  } = {},
): Promise<CommandResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, [...args], {
      cwd: root,
      env: options.env ?? process.env,
      stdio: [
        options.input === undefined ? 'ignore' : 'pipe',
        options.inherit ? 'inherit' : 'pipe',
        options.inherit ? 'inherit' : 'pipe',
      ],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, options.timeoutMs)
      : undefined

    if (!options.inherit) {
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
    }

    child.on('error', (error) => {
      if (timeout) {
        clearTimeout(timeout)
      }
      reject(error)
    })
    child.on('exit', (code, signal) => {
      if (timeout) {
        clearTimeout(timeout)
      }
      const result = { code: code ?? 1, stdout, stderr }
      if (timedOut) {
        reject(new Error(`${redactCommand(command, args)} timed out after ${options.timeoutMs}ms`))
        return
      }
      if (!options.allowFailure && result.code !== 0) {
        reject(
          new Error(
            `${redactCommand(command, args)} exited with ${signal ?? result.code}\n${stderr}`,
          ),
        )
        return
      }
      resolveRun(result)
    })

    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    }
  })
}

async function writeEnvFile(path: string, env: Record<string, string>): Promise<void> {
  const lines = Object.entries(env).map(([key, value]) => `${key}=${value}`)
  await writeFile(path, `${lines.join('\n')}\n`, { mode: 0o600 })
}

async function installDockerCliPluginLinks(dockerConfigDir: string): Promise<void> {
  const home = process.env.HOME
  if (!home) {
    return
  }

  await symlink(
    resolve(home, '.docker/cli-plugins'),
    resolve(dockerConfigDir, 'cli-plugins'),
  ).catch(() => undefined)
}

async function waitForHttp(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Polling observes one external health state.
      const response = await fetch(url)
      if (response.ok) {
        return response
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    // oxlint-disable-next-line no-await-in-loop -- Bounded smoke polling uses short backoff.
    await Bun.sleep(250)
  }

  fail(`timed out waiting for ${url}: ${String(lastError)}`)
}

async function assertText(url: string, expected: readonly string[]): Promise<Response> {
  const response = await fetch(url)
  if (!response.ok) {
    fail(`${url} returned HTTP ${response.status}`)
  }
  const body = await response.text()
  for (const text of expected) {
    assertIncludes(body, text, url)
  }
  return response
}

async function assertBootRefusals(tmp: string): Promise<void> {
  const missingEnv = await run('docker', ['run', '--rm', imageName], {
    allowFailure: true,
    timeoutMs: 15_000,
  })
  if (missingEnv.code === 0) {
    fail('container without required env exited 0')
  }
  assertIncludes(missingEnv.stderr, 'press server boot refused', 'missing-env refusal')
  assertIncludes(missingEnv.stderr, 'PRESS_BASE_URL', 'missing-env refusal')

  const refusalEnvFile = resolve(tmp, 'prod-credential-refusal.env')
  await writeEnvFile(refusalEnvFile, productionCredentialRefusalEnv())
  const prodCredential = await run(
    'docker',
    ['run', '--rm', '--env-file', refusalEnvFile, imageName],
    {
      allowFailure: true,
      timeoutMs: 15_000,
    },
  )
  if (prodCredential.code === 0) {
    fail('production credential-auth container exited 0')
  }
  assertIncludes(
    prodCredential.stderr,
    'PRESS_ENABLE_CREDENTIAL_AUTH',
    'production credential-auth refusal',
  )
  assertIncludes(prodCredential.stderr, 'production', 'production credential-auth refusal')
}

async function migrateAndSeed(env: SmokeEnv): Promise<void> {
  await run(
    'docker',
    ['compose', '-f', composeFile, '-p', projectName, 'up', '-d', '--wait', 'postgres'],
    { env, timeoutMs: 60_000, inherit: true },
  )
  await run('nub', ['run', '--filter', '@press/web', 'db:migrate'], {
    env,
    timeoutMs: 60_000,
    inherit: true,
  })
  await run('nub', ['run', '--filter', '@press/web', 'db:seed'], {
    env,
    timeoutMs: 60_000,
    inherit: true,
  })
}

async function startAppContainer(envFile: string, storageDir: string): Promise<void> {
  await run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      appContainer,
      '--network',
      networkName,
      '--env-file',
      envFile,
      '-p',
      `127.0.0.1:${webPort}:4174`,
      '-v',
      `${storageDir}:/data/press-storage:rw`,
      imageName,
    ],
    { timeoutMs: 30_000 },
  )
}

async function assertContainerHttp(): Promise<void> {
  const health = await waitForHttp(`${baseUrl}/healthz`, 30_000)
  if ((await health.text()) !== 'ok\n') {
    fail('/healthz returned unexpected body')
  }

  await assertText(`${baseUrl}/`, [
    'press-shell',
    'Reports for close reading.',
    'Agent Margin Review',
  ])

  const page = await assertText(`${baseUrl}/p/market-notes/agent-margin-review.html`, [
    '<title>Agent Margin Review</title>',
    'Seeded localnet report for press screenshot and index verification.',
  ])
  const actualCsp = page.headers.get('content-security-policy')
  if (actualCsp !== requiredCsp) {
    fail(`sandbox CSP mismatch: expected "${requiredCsp}", got "${actualCsp}"`)
  }
}

async function cleanup(tmp: string | undefined, env: SmokeEnv | undefined): Promise<void> {
  await run('docker', ['rm', '-f', appContainer], {
    allowFailure: true,
    timeoutMs: 15_000,
  }).catch(() => undefined)
  if (env) {
    await run(
      'docker',
      ['compose', '-f', composeFile, '-p', projectName, 'down', '--volumes', '--remove-orphans'],
      { env, allowFailure: true, timeoutMs: 30_000, inherit: true },
    ).catch(() => undefined)
  }
  if (tmp) {
    await rm(tmp, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  let tmp: string | undefined
  let env: SmokeEnv | undefined

  try {
    tmp = await mkdtemp(resolve(tmpdir(), 'press-image-smoke-'))
    const storageDir = resolve(tmp, 'storage')
    const dockerConfigDir = resolve(tmp, 'docker-config')
    const envFile = resolve(tmp, 'container.env')
    process.env.DOCKER_CONFIG = dockerConfigDir
    await mkdir(dockerConfigDir, { recursive: true })
    await installDockerCliPluginLinks(dockerConfigDir)
    await mkdir(dirname(storageDir), { recursive: true })
    await mkdir(storageDir, { recursive: true })
    await writeEnvFile(envFile, localnetContainerEnv())
    env = localnetHostEnv(storageDir)

    await run('docker', ['buildx', 'build', '--progress=plain', '--load', '-t', imageName, '.'], {
      timeoutMs: 10 * 60_000,
      inherit: true,
    })
    await assertBootRefusals(tmp)
    await migrateAndSeed(env)
    await startAppContainer(envFile, storageDir)
    await assertContainerHttp()

    console.log(`press image smoke passed for ${imageName}`)
  } catch (error) {
    const logs = await run('docker', ['logs', appContainer], {
      allowFailure: true,
      timeoutMs: 10_000,
    }).catch(() => undefined)
    if (logs && (logs.stdout || logs.stderr)) {
      console.error(logs.stdout)
      console.error(logs.stderr)
    }
    throw error
  } finally {
    await cleanup(tmp, env)
  }
}

void main()
