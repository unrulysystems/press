import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The `press` CLI stores its token by shelling out to the macOS `security` binary
// (find/add/delete-generic-password). For hermetic tests and harnesses we shadow `security`
// on PATH with a stub that reimplements just those verbs against a JSON file named by
// PRESS_E2E_KEYCHAIN_FILE — so a real `press login` round-trips a real token without ever
// touching the operator's OS keychain (which would also trip a biometric/Boundary prompt).
// Put `dir` first on PATH so this stub wins over the system `security`.
export async function writeKeychainStub(dir: string): Promise<void> {
  const path = join(dir, 'security')
  await writeFile(
    path,
    `#!/usr/bin/env bun
const file = process.env.PRESS_E2E_KEYCHAIN_FILE
if (!file) process.exit(64)
const args = Bun.argv.slice(2)
function option(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
async function readState() {
  try {
    return JSON.parse(await Bun.file(file).text())
  } catch {
    return {}
  }
}
async function writeState(state) {
  await Bun.write(file, JSON.stringify(state))
}
const service = option('-s')
const account = option('-a') || 'token'
const key = service + ':' + account
const state = await readState()
switch (args[0]) {
  case 'find-generic-password':
    if (!state[key]) process.exit(44)
    process.stdout.write(state[key])
    break
  case 'add-generic-password': {
    const token = await new Response(Bun.stdin.stream()).text()
    if (!token) process.exit(65)
    state[key] = token
    await writeState(state)
    break
  }
  case 'delete-generic-password':
    delete state[key]
    await writeState(state)
    break
  default:
    process.exit(64)
}
`,
  )
  await chmod(path, 0o700)
}
