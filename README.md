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
- `packages/cli` — the `press` CLI: browser-loopback login, token stored in
  the OS keychain (or `PRESS_TOKEN` for agents/CI).
- **Data** — Postgres (Drizzle) rows are the source of truth; report blobs are
  flat files under `PRESS_STORAGE_DIR/<collection>/<file>`.

`VISION.md` is the why, `SPEC.md` the contract, `BRIEF.md` the engineering
quality law, `docs/ops.md` the backup/restore runbook, `AUDIT.md` the security
audit ledger.

## Quickstart (local development)

Prerequisites: [Bun](https://bun.sh), Docker, [Tilt](https://tilt.dev), and
[nub](https://github.com/nubjs/nub) for the workspace runner.

```sh
nub install          # install workspace deps (frozen lockfile)
nub run localnet     # boot Postgres + dev server with seeded users
```

`nub run localnet` boots the silo/Tilt stack and prints the base URL, seeded
users, collections, and example page URLs. In another shell:

```sh
nub run check        # typecheck + lint + format gates
nub run test         # unit/integration tests
nub run e2e          # full Playwright acceptance suite (localnet only)
```

## CLI

```sh
press login          # browser-loopback sign-in; token to the OS keychain
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
`BETTER_AUTH_SECRET`, OAuth client credentials, `PRESS_MAX_UPLOAD_BYTES`).
Instance manifests and registry mirroring are operator-managed outside this
repo. See `docs/ops.md` for backup/restore and archive purge.

## Security

`AUDIT.md` is the security audit ledger; every verified finding is resolved
and regression-covered. The e2e suite asserts boot fail-closed (production
refuses credential auth without a real provider), the exact sandbox CSP on
served pages, and no plaintext secrets in the loop.
