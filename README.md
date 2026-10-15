# press

Self-hosted, CLI-published, identity-gated HTML report publishing. MIT licensed.

Publish a self-contained HTML report in one command; readers get a
magazine-grade site with per-page access control. Self-hosted — no third
party sits in the data path.

## Features

- **CLI-published** — `press publish report.html --to weekly` prints a URL.
  One command, under five seconds. Agents can publish unattended with a
  human-minted credential.
- **Identity-gated ACL** — per-page visibility: `default` (allowed email
  domains), `public`, `password`, or `private` (email allowlist).
- **Magazine-grade reading surface** — a calm, typographic news feed, not an
  internal tool.
- **Report isolation** — served pages run under a strict sandbox CSP and can
  never read other pages or act as their viewer.
- **Auditable** — every mutation writes an attributed audit event.
- **Self-contained runtime** — one container image + Postgres; secrets come
  from your own store.

## How it works

- `apps/web` — a One (OneStack) app: the magazine UI and the API (auth,
  publish, serving) as plain `Request → Response` handlers.
- `packages/cli` — the `press` CLI: browser-loopback login by default,
  `press login --device` for remote/headless hosts; token stored in the OS
  keychain, then a 0600 XDG file store, or `PRESS_TOKEN` for agents/CI.
- **Data** — Postgres (Drizzle) rows are the source of truth; report blobs are
  flat files under `PRESS_STORAGE_DIR/<collection>/<file>`.

`VISION.md` is the why, `SPEC.md` the contract, `BRIEF.md` the engineering
quality law, `docs/ops.md` the backup/restore runbook, `AUDIT.md` the security
audit ledger.

## Quickstart (local development)

Prerequisites: [Bun 1.4.3](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.3),
Node 24, Docker, [Tilt](https://tilt.dev), and [silo](https://github.com/0xbigboss/silo).
The Nix dev shell (including the `shell.nix` fallback) provides Node and the
development tools; Bun is installed separately from the official release:

```sh
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.3"
export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
bun --version        # must print 1.4.3
```

```sh
bun install --frozen-lockfile # install the locked workspace dependencies
bun run localnet     # boot Postgres + dev server with seeded users
```

`bun run localnet` boots the silo/Tilt stack and prints the base URL, seeded
users, collections, and example page URLs. In another shell:

```sh
bun run check        # typecheck + lint + format gates
bun run test         # unit/integration tests
bun run e2e          # full Playwright acceptance suite (localnet only)
```

## CLI

```sh
press login          # browser-loopback sign-in; token to the OS keychain
press login --device # remote/headless: print a URL + user code, poll until approved
press doctor         # status: resolved host, token source, identity
press publish report.html --to weekly [--visibility private] [--allow a@b.c]
press list [collection]
press page set weekly/q3.html --visibility public
press move weekly/q3.html weekly/q3-final.html [--redirect permanent|none]
press unpublish weekly/q3.html
press whoami
press logout          # revoke and forget the token
```

Passwords are never argv: `--password` prompts (or reads `PRESS_PAGE_PASSWORD`
/ stdin), and the effective password is printed exactly once.

## Deployment

One container image (`ghcr.io/unrulysystems/press`, published by the release
workflow on `v*` tags) plus Postgres. An instance is configured entirely by
env: identity-provider client, allowed email domains, hostname, storage
(`PRESS_BASE_URL`, `PRESS_ALLOWED_DOMAINS`, `PRESS_ADMIN_EMAILS`,
`BETTER_AUTH_SECRET`, OAuth client credentials, `PRESS_MAX_UPLOAD_BYTES`,
`PRESS_MAX_METADATA_BYTES`).
Instance manifests and registry mirroring are operator-managed outside this
repo. See `docs/ops.md` for backup/restore and archive purge.

## Security

`AUDIT.md` is the security audit ledger; every verified finding is resolved
and regression-covered. The e2e suite asserts boot fail-closed (production
refuses credential auth without a real provider), the exact sandbox CSP on
served pages, and no plaintext secrets in the loop.
