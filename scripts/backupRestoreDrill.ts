import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import { bootLocalnet, withLocalnetDefaults } from './localnet'

type DrillEnv = NodeJS.ProcessEnv & Record<string, string>
type CommandResult = {
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: Buffer
}
type AclFacts = {
  readonly publicStatus: number
  readonly defaultNonHtmlStatus: number
}
type BaselineFacts = {
  readonly acl: AclFacts
  readonly blobHash: string
  readonly contentHash: string
}

const root = resolve(import.meta.dirname, '..')
const composeFile = resolve(root, 'compose.yaml')
const projectName = `press-backup-restore-drill-${process.pid}`
const drillBasePort = Number(process.env.PRESS_DRILL_PORT ?? `${49_000 + (process.pid % 1_000)}`)
const postgresPort = `${drillBasePort + 1}`
const webPort = `${drillBasePort + 2}`
const baseUrl = `http://127.0.0.1:${webPort}`
const publicCollection = 'market-notes'
const publicFile = 'agent-margin-review.html'
const defaultCollection = 'systems-review'
const defaultFile = 'latency-budget-audit.html'

function fail(message: string): never {
  throw new Error(message)
}

function redactCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ')
}

function run(
  command: string,
  args: readonly string[],
  options: {
    readonly env?: DrillEnv
    readonly input?: Buffer
    readonly timeoutMs?: number
    readonly allowFailure?: boolean
  } = {},
): Promise<CommandResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, [...args], {
      cwd: root,
      env: options.env ?? process.env,
      stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let timedOut = false
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, options.timeoutMs)
      : undefined

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
    })
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
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }
      if (timedOut) {
        reject(new Error(`${redactCommand(command, args)} timed out after ${options.timeoutMs}ms`))
        return
      }
      if (!options.allowFailure && result.code !== 0) {
        reject(
          new Error(
            `${redactCommand(command, args)} exited with ${signal ?? result.code}\n${result.stderr.toString()}`,
          ),
        )
        return
      }
      resolveRun(result)
    })

    if (options.input) {
      child.stdin?.end(options.input)
    }
  })
}

function drillEnv(storageDir: string): DrillEnv {
  return {
    ...withLocalnetDefaults(),
    PRESS_PORT: webPort,
    PRESS_POSTGRES_PORT: postgresPort,
    PRESS_BASE_URL: baseUrl,
    DATABASE_URL: `postgres://press:press@127.0.0.1:${postgresPort}/press`,
    PRESS_STORAGE_DIR: storageDir,
  }
}

function blobPath(storageDir: string): string {
  return resolve(storageDir, publicCollection, publicFile)
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function postgresContainer(env: DrillEnv): Promise<string> {
  const result = await run(
    'docker',
    ['compose', '-f', composeFile, '-p', projectName, 'ps', '-q', 'postgres'],
    { env, timeoutMs: 15_000 },
  )
  const container = result.stdout.toString().trim()
  if (!container) {
    fail(`postgres container not found for compose project ${projectName}`)
  }
  return container
}

async function querySingle(env: DrillEnv, sql: string): Promise<string> {
  const container = await postgresContainer(env)
  const result = await run(
    'docker',
    [
      'exec',
      container,
      'psql',
      '-U',
      'press',
      '-d',
      'press',
      '-t',
      '-A',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { env, timeoutMs: 15_000 },
  )
  const rows = result.stdout
    .toString()
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean)
  if (rows.length !== 1) {
    fail(`expected one SQL row for ${sql}, got ${rows.length}: ${result.stdout.toString()}`)
  }
  return rows[0] ?? fail(`SQL row unexpectedly missing for ${sql}`)
}

async function probeAcl(): Promise<AclFacts> {
  const publicResponse = await fetch(`${baseUrl}/p/${publicCollection}/${publicFile}`, {
    headers: { Accept: 'text/html' },
  })
  const defaultResponse = await fetch(`${baseUrl}/p/${defaultCollection}/${defaultFile}`, {
    headers: { Accept: 'application/json' },
  })
  return {
    publicStatus: publicResponse.status,
    defaultNonHtmlStatus: defaultResponse.status,
  }
}

async function recordFacts(env: DrillEnv, storageDir: string): Promise<BaselineFacts> {
  const contentHash = await querySingle(
    env,
    `select "contentHash" from "page" where "collectionSlug" = '${publicCollection}' and "fileSlug" = '${publicFile}' and "archivedAt" is null`,
  )
  const facts = {
    acl: await probeAcl(),
    blobHash: await sha256File(blobPath(storageDir)),
    contentHash,
  }
  if (facts.acl.publicStatus !== 200) {
    fail(`public ACL probe returned ${facts.acl.publicStatus}, expected 200`)
  }
  if (facts.acl.defaultNonHtmlStatus !== 401) {
    fail(`default non-HTML ACL probe returned ${facts.acl.defaultNonHtmlStatus}, expected 401`)
  }
  if (facts.contentHash !== facts.blobHash) {
    fail(`page contentHash ${facts.contentHash} did not match blob hash ${facts.blobHash}`)
  }
  return facts
}

async function takeBackup(env: DrillEnv, storageDir: string, backupDir: string): Promise<void> {
  const container = await postgresContainer(env)
  await mkdir(backupDir, { recursive: true })
  const dump = await run(
    'docker',
    ['exec', container, 'pg_dump', '-Fc', '--no-owner', '--no-privileges', '-U', 'press', 'press'],
    { env, timeoutMs: 60_000 },
  )
  await writeFile(resolve(backupDir, 'database.dump'), dump.stdout)
  await cp(storageDir, resolve(backupDir, 'blobs'), { recursive: true })
}

async function restoreBackup(env: DrillEnv, storageDir: string, backupDir: string): Promise<void> {
  const container = await postgresContainer(env)
  await run(
    'docker',
    [
      'exec',
      '-i',
      container,
      'pg_restore',
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '-U',
      'press',
      '-d',
      'press',
    ],
    {
      env,
      input: await readFile(resolve(backupDir, 'database.dump')),
      timeoutMs: 60_000,
    },
  )
  await rm(storageDir, { recursive: true, force: true })
  await mkdir(dirname(storageDir), { recursive: true })
  await cp(resolve(backupDir, 'blobs'), storageDir, { recursive: true })
}

async function composeDown(env: DrillEnv): Promise<void> {
  await run(
    'docker',
    ['compose', '-f', composeFile, '-p', projectName, 'down', '--volumes', '--remove-orphans'],
    { env, timeoutMs: 30_000, allowFailure: true },
  ).catch(() => undefined)
}

function assertRestoredFacts(baseline: BaselineFacts, restored: BaselineFacts): void {
  if (restored.contentHash !== baseline.contentHash) {
    fail(`restored contentHash ${restored.contentHash} did not match ${baseline.contentHash}`)
  }
  if (restored.blobHash !== baseline.blobHash) {
    fail(`restored blob hash ${restored.blobHash} did not match ${baseline.blobHash}`)
  }
  if (restored.acl.publicStatus !== baseline.acl.publicStatus) {
    fail(
      `restored public ACL status ${restored.acl.publicStatus} did not match ${baseline.acl.publicStatus}`,
    )
  }
  if (restored.acl.defaultNonHtmlStatus !== baseline.acl.defaultNonHtmlStatus) {
    fail(
      `restored default ACL status ${restored.acl.defaultNonHtmlStatus} did not match ${baseline.acl.defaultNonHtmlStatus}`,
    )
  }
}

async function main(): Promise<void> {
  let tmp: string | undefined
  let activeBoot: Awaited<ReturnType<typeof bootLocalnet>> | undefined
  let env: DrillEnv | undefined

  try {
    tmp = await mkdtemp(resolve(tmpdir(), 'press-backup-restore-drill-'))
    const storageDir = resolve(tmp, 'storage')
    const backupDir = resolve(tmp, 'backup')
    env = drillEnv(storageDir)

    activeBoot = await bootLocalnet([], { env, projectName })
    const baseline = await recordFacts(env, storageDir)
    await takeBackup(env, storageDir, backupDir)

    await activeBoot.stop()
    activeBoot = undefined
    await rm(storageDir, { recursive: true, force: true })

    activeBoot = await bootLocalnet([], {
      beforeServer: async () => {
        await restoreBackup(env ?? fail('drill env missing'), storageDir, backupDir)
      },
      env,
      prepareDb: 'none',
      projectName,
    })
    const restored = await recordFacts(env, storageDir)
    assertRestoredFacts(baseline, restored)

    console.log('PASS backup/restore drill')
    console.log(`page: ${publicCollection}/${publicFile}`)
    console.log(`contentHash: ${restored.contentHash}`)
    console.log(`blobSha256: ${restored.blobHash}`)
    console.log(
      `acl: public=${restored.acl.publicStatus} default-non-html=${restored.acl.defaultNonHtmlStatus}`,
    )
    console.log('snapshotOrder: database dump first, blob snapshot second')
  } finally {
    await activeBoot?.stop()
    if (env) {
      await composeDown(env)
    }
    if (tmp) {
      await rm(tmp, { recursive: true, force: true })
    }
  }
}

void main()
