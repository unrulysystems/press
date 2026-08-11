import { spawn, spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CLI_PACKAGE_VERSION,
  buildCliBinary,
  defaultCliBinary,
  hostReleasePlatform,
  packageCliBinary,
  sha256File,
} from './cliRelease'
import { removeKeychainToken } from '../packages/cli/src/keychain'

type CommandResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function fail(message: string): never {
  throw new Error(message)
}

function run(
  binary: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): CommandResult {
  const result = spawnSync(binary, [...args], { cwd, env, encoding: 'utf8' })
  if (result.error) {
    throw result.error
  }
  return {
    code: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function expectSuccess(result: CommandResult, label: string): void {
  if (result.code !== 0) {
    fail(`${label} exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
}

function runAsync(
  binary: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, [...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${binary} ${args.join(' ')} timed out after 15s`))
    }, 15_000)
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

async function verifyMacKeychainRoundTrip(
  binary: string,
  cwd: string,
  baseEnv: NodeJS.ProcessEnv,
): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }

  const token = crypto.randomUUID()
  const email = 'standalone-keychain-smoke@example.invalid'
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const authorized = request.headers.authorization === `Bearer ${token}`
    let status = 200
    let body: unknown
    if (url.pathname === '/api/cli/exchange' && request.method === 'POST') {
      body = { token, user: { email } }
    } else if (url.pathname === '/api/cli/whoami' && authorized) {
      body = { user: { email } }
    } else if (url.pathname === '/api/cli/logout' && request.method === 'POST' && authorized) {
      body = { ok: true }
    } else {
      status = 404
      body = { error: 'not found' }
    }
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const env = {
    ...baseEnv,
    // Security.framework resolves the login Keychain for the real runner user;
    // the hermetic HOME used by the no-checkout smoke must not hide it.
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  }
  delete env.PRESS_E2E_KEYCHAIN_FILE

  try {
    const child = spawn(binary, ['--host', host, 'login', '--no-open'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let completedCallback = false
    const login = new Promise<CommandResult>((resolveLogin, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('real Keychain login smoke timed out after 15s'))
      }, 15_000)
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
        const match = /(http:\/\/127\.0\.0\.1:\d+\/cli\/authorize\?[^\s]+)/.exec(stdout)
        if (match?.[1] && !completedCallback) {
          completedCallback = true
          const authorizeUrl = new URL(match[1])
          const callbackPort = authorizeUrl.searchParams.get('port')
          const state = authorizeUrl.searchParams.get('state')
          if (!callbackPort || !state) {
            reject(new Error('login authorize URL omitted callback state'))
            return
          }
          void fetch(
            `http://127.0.0.1:${callbackPort}/callback?code=smoke-code&state=${encodeURIComponent(state)}`,
          )
            .then((response) => {
              if (!response.ok) {
                throw new Error(`login callback returned HTTP ${response.status}`)
              }
              return undefined
            })
            .catch(reject)
        }
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
        resolveLogin({ code: code ?? 1, stdout, stderr })
      })
    })
    const loginResult = await login
    expectSuccess(loginResult, 'real Keychain press login')

    const doctorResult = await runAsync(binary, ['--host', host, 'doctor', '--json'], cwd, env)
    expectSuccess(doctorResult, 'real Keychain press doctor')
    const doctorBody = JSON.parse(doctorResult.stdout) as {
      readonly data?: { readonly tokenSource?: unknown; readonly authenticated?: unknown }
    }
    if (doctorBody.data?.tokenSource !== 'keychain' || doctorBody.data.authenticated !== true) {
      fail(`real Keychain doctor did not authenticate: ${doctorResult.stdout}`)
    }

    const logoutResult = await runAsync(binary, ['--host', host, 'logout', '--json'], cwd, env)
    expectSuccess(logoutResult, 'real Keychain press logout')
    const afterLogout = await runAsync(binary, ['--host', host, 'doctor', '--json'], cwd, env)
    expectSuccess(afterLogout, 'post-logout press doctor')
    const afterLogoutBody = JSON.parse(afterLogout.stdout) as {
      readonly data?: { readonly tokenSource?: unknown }
    }
    if (afterLogoutBody.data?.tokenSource !== 'none') {
      fail(`real Keychain token remained after logout: ${afterLogout.stdout}`)
    }
  } finally {
    try {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolveClose()
        })
      })
    } finally {
      await removeKeychainToken(host).catch(() => undefined)
    }
  }
}

const platform = hostReleasePlatform()
// Capture the release artifact's bytes before any verifier build runs; the
// harness must leave artifacts/cli/press untouched (F-16, review round 2).
// Only a genuinely absent artifact is accepted as undefined; any read failure
// must fail loudly so the no-clobber check stays fail-closed.
async function artifactFingerprint(file: string): Promise<string | undefined> {
  try {
    return await sha256File(file)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}
const releaseArtifactBefore = await artifactFingerprint(defaultCliBinary)
const isolated = await mkdtemp(join(tmpdir(), 'press-cli-standalone-'))
const isolatedPath = join(isolated, 'path')
const binary = join(isolated, 'press')
const keychainFile = join(isolated, 'keychain.json')
const preloadMarker = join(isolated, 'bunfig-preload-ran')
await mkdir(isolatedPath)
// Build both variants to private outfiles: the verifier must never write to
// artifacts/cli/press (the release artifact), or the packaging step that
// follows in release.yml could consume a seam-enabled binary (F-16, review
// round 2).
const builtBinary = await buildCliBinary({
  platform,
  outfile: join(isolated, 'test-build.bin'),
})
const releaseBinary = await buildCliBinary({
  platform,
  testBuild: false,
  outfile: join(isolated, 'release-press.bin'),
})
await copyFile(builtBinary, binary)
await chmod(binary, 0o755)

const env = {
  ...process.env,
  PATH: isolatedPath,
  HOME: isolated,
  PRESS_E2E_KEYCHAIN_FILE: keychainFile,
}
delete env.BUN_INSTALL
delete env.BUNFIG
delete env.PRESS_HOST
delete env.PRESS_TOKEN

const version = run(binary, ['--version'], isolated, env)
expectSuccess(version, 'press --version')
if (version.stdout !== `${CLI_PACKAGE_VERSION}\n` || version.stderr !== '') {
  fail(`press --version output mismatch: ${JSON.stringify(version)}`)
}

const doctor = run(
  binary,
  ['--host', 'https://standalone.invalid', 'doctor', '--json'],
  isolated,
  env,
)
expectSuccess(doctor, 'press doctor --json')
const report = JSON.parse(doctor.stdout) as {
  readonly ok?: boolean
  readonly data?: { readonly host?: unknown; readonly tokenSource?: unknown }
}
if (
  report.ok !== true ||
  report.data?.host !== 'https://standalone.invalid' ||
  report.data.tokenSource !== 'none'
) {
  fail(`press doctor --json returned an invalid report: ${doctor.stdout}`)
}

// A compiled executable must ignore ambient project/runtime configuration. If
// either file is loaded, doctor gains a host or the preload leaves a marker.
await writeFile(join(isolated, '.env'), 'PRESS_HOST=https://ambient.invalid\n')
await writeFile(join(isolated, 'bunfig.toml'), `preload = ["./preload.ts"]\n`)
await writeFile(
  join(isolated, 'preload.ts'),
  `await Bun.write(${JSON.stringify(preloadMarker)}, 'loaded')\n`,
)
const ambientDoctor = run(binary, ['doctor', '--json'], isolated, env)
if (ambientDoctor.code !== 1 || !ambientDoctor.stdout.includes('host required')) {
  fail(`compiled CLI loaded ambient .env unexpectedly: ${JSON.stringify(ambientDoctor)}`)
}
if (await Bun.file(preloadMarker).exists()) {
  fail('compiled CLI loaded ambient bunfig.toml unexpectedly')
}

if (process.env.PRESS_VERIFY_REAL_KEYCHAIN === '1') {
  await verifyMacKeychainRoundTrip(binary, isolated, env)
}

// F-16: only the hermetic test/e2e build may honor PRESS_E2E_KEYCHAIN_FILE. A
// release binary must never let that variable reroute token storage to a
// plaintext file: seed the seam with a probe token and assert doctor reports
// it for the test build and ignores it for the release build.
const seamHost = 'https://press-seam.invalid'
const seamFile = join(isolated, 'seam-keychain.json')
await writeFile(
  seamFile,
  JSON.stringify({ [`press:${seamHost}:press-cli-token`]: 'press_seam_probe_token' }),
)
const seamEnv = { ...env, PRESS_E2E_KEYCHAIN_FILE: seamFile }
const seamfulDoctor = run(builtBinary, ['--host', seamHost, 'doctor', '--json'], isolated, seamEnv)
const seamfulReport = JSON.parse(seamfulDoctor.stdout) as {
  readonly ok?: boolean
  readonly data?: { readonly tokenSource?: string }
}
if (seamfulReport.ok !== true || seamfulReport.data?.tokenSource !== 'keychain') {
  fail(`test-build CLI did not honor the keychain seam: ${seamfulDoctor.stdout}`)
}
const seamlessDoctor = run(
  releaseBinary,
  ['--host', seamHost, 'doctor', '--json'],
  isolated,
  seamEnv,
)
const seamlessReport = JSON.parse(seamlessDoctor.stdout) as {
  readonly ok?: boolean
  readonly data?: { readonly tokenSource?: string }
}
if (seamlessReport.ok !== true || seamlessReport.data?.tokenSource !== 'none') {
  fail(`release CLI honored the keychain seam (F-16): ${seamlessDoctor.stdout}`)
}

// The release workflow builds its seam-free artifact at artifacts/cli/press
// BEFORE this harness runs and packages it AFTER, so any clobber ships a
// seam-enabled binary (F-16, review round 2). Fail loudly instead.
if (releaseArtifactBefore !== (await artifactFingerprint(defaultCliBinary))) {
  fail('verifier must not modify the release artifact at artifacts/cli/press (F-16)')
}

const packaged = await packageCliBinary({ binary, platform, outdir: join(isolated, 'release') })
const checksumLine = (await readFile(packaged.checksumFile, 'utf8')).trim()
const expectedChecksum = await sha256File(packaged.archive)
if (checksumLine !== `${expectedChecksum}  ${packaged.archive.split('/').at(-1)}`) {
  fail(`release checksum mismatch: ${checksumLine}`)
}

console.log(`standalone CLI verified: ${platform} ${CLI_PACKAGE_VERSION}`)
console.log(packaged.archive)
