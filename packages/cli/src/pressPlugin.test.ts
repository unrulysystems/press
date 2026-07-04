import { describe, expect, test } from 'bun:test'

// The plugin lives at the repo root under plugins/press. This test is colocated in
// packages/cli only because `nub run test` globs `packages apps/web/src`; it validates
// the plugin structure and that the skills cite only real `press` subcommands. Paths and
// reads use Bun globals (this package's tsconfig has no node type declarations).
const pluginRoot = `${import.meta.dir}/../../../plugins/press`

// The real `press` subcommand first-words, kept in sync with the command switch in
// index.ts. `page set` is a two-word command whose first word is `page`.
const REAL_PRESS_COMMANDS = new Set([
  'login',
  'logout',
  'whoami',
  'doctor',
  'publish',
  'list',
  'page',
  'unpublish',
])

async function read(relativePath: string): Promise<string> {
  return Bun.file(`${pluginRoot}/${relativePath}`).text()
}

// Extract `press <cmd>` invocations from fenced code blocks and inline single-line code
// spans only — never prose — so a sentence containing the word "press" is not treated as
// a command citation.
function citedPressCommands(markdown: string): string[] {
  const commands: string[] = []
  for (const block of markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    for (const line of (block[1] ?? '').split('\n')) {
      const match = line.match(/^\s*press\s+([a-z-]+)/)
      if (match?.[1]) {
        commands.push(match[1])
      }
    }
  }
  for (const span of markdown.matchAll(/`([^`\n]+)`/g)) {
    const match = (span[1] ?? '').match(/^press\s+([a-z-]+)/)
    if (match?.[1]) {
      commands.push(match[1])
    }
  }
  return commands
}

describe('press plugin manifest', () => {
  // A cross-tool plugin needs BOTH ingestion manifests: Claude Code reads
  // .claude-plugin/plugin.json, Codex reads .codex-plugin/plugin.json. Both must point at
  // the same shared ./skills.
  const manifestPaths = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'] as const

  for (const manifestPath of manifestPaths) {
    test(`${manifestPath} is valid JSON with the required fields`, async () => {
      const manifest = JSON.parse(await read(manifestPath)) as Record<string, unknown>
      expect(manifest.name).toBe('press')
      expect(typeof manifest.description).toBe('string')
      expect(manifest.skills).toBe('./skills')
      expect(typeof manifest.version).toBe('string')
    })
  }

  test('the Codex manifest carries the interface block Codex ingestion expects', async () => {
    const codex = JSON.parse(await read('.codex-plugin/plugin.json')) as {
      readonly interface?: Record<string, unknown>
    }
    expect(codex.interface).toBeDefined()
    expect(typeof codex.interface?.displayName).toBe('string')
    expect(Array.isArray(codex.interface?.capabilities)).toBe(true)
    expect(Array.isArray(codex.interface?.defaultPrompt)).toBe(true)
  })

  test('ships both cross-tool entry docs', async () => {
    expect(await read('CLAUDE.md')).toContain('press-setup')
    expect(await read('AGENTS.md')).toContain('press-publish')
  })
})

describe('press plugin skills', () => {
  const skills = ['press-setup', 'press-publish'] as const

  for (const skill of skills) {
    test(`${skill} has valid frontmatter and a body`, async () => {
      const content = await read(`skills/${skill}/SKILL.md`)
      expect(content.startsWith('---')).toBe(true)
      expect(content).toContain(`name: ${skill}`)
      expect(content).toContain('description:')
    })

    test(`${skill} cites only real press commands`, async () => {
      const cited = citedPressCommands(await read(`skills/${skill}/SKILL.md`))
      // Each skill must actually invoke the CLI it documents.
      expect(cited.length).toBeGreaterThan(0)
      for (const command of cited) {
        expect(REAL_PRESS_COMMANDS.has(command)).toBe(true)
      }
    })
  }

  test('the two skills cover setup verification and publishing', async () => {
    const setup = citedPressCommands(await read('skills/press-setup/SKILL.md'))
    const publish = citedPressCommands(await read('skills/press-publish/SKILL.md'))
    // Setup must verify auth; publish must actually publish.
    expect(setup).toContain('whoami')
    expect(publish).toContain('publish')
  })
})
