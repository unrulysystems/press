# press plugin (Codex)

Publish identity-gated HTML reports with the `press` CLI. Two skills cover the
whole path from nothing to a shared URL:

- **press-setup** (`skills/press-setup/SKILL.md`) — acquire and verify an auth
  token (agent or interactive).
- **press-publish** (`skills/press-publish/SKILL.md`) — compose an HTML report,
  publish it, and confirm the returned URL and its access control.

Read the matching SKILL.md and follow it. Start with press-setup if
`press doctor` reports not authenticated; otherwise go straight to press-publish.

## The `press` CLI

Real subcommands (do not invent others):

- `press login` — interactive browser sign-in; stores the token in the OS keychain.
- `press logout` — revoke and forget the current token.
- `press whoami` — print the authenticated identity (exits non-zero when
  unauthenticated).
- `press doctor` — status: resolved host, token source, whoami result, next-step.
  Add `--json` for a machine-readable envelope.
- `press publish <file> --to <collection> [--as <slug>] [--visibility <v>] [--allow <emails>]`
  — publish an HTML file; prints the URL (and a one-time password when
  `--visibility password`).
- `press list [collection]` — list collections, or pages within a collection.
- `press page set <collection>/<file> [--visibility <v>] [--allow <emails>]` — change
  a page's access control.
- `press move` `<source-collection/source-file> <destination-collection/destination-file>`
  `[--redirect permanent|none]` — change a page's canonical path; defaults to a
  permanent redirect from the old path.
- `press unpublish <collection>/<file>` — remove a page.

Global flags: `--host <url>` (or `PRESS_HOST`), `--json`. Visibility values:
`public`, `default`, `password`, `private`.

## Configuration (secrets stay out of argv and logs)

- `PRESS_HOST` — the press instance URL (or pass `--host`).
- `PRESS_TOKEN` — bearer token for non-interactive/agent use. Export it in the
  environment; never pass a token as a command-line argument.

For localnet testing, `nub run dev:share` writes `.dev/agent.env` with
`PRESS_TOKEN` and `PRESS_URL`. Map it for the CLI with
`export PRESS_HOST="$PRESS_URL"` (the CLI reads `PRESS_HOST`, not `PRESS_URL`).

In the press repo, run the CLI directly with `bun packages/cli/src/index.ts <args>`
wherever these skills say `press <args>`.
