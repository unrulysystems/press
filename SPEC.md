# press — SPEC

The contract for press v1. See `VISION.md` for why, `BRIEF.md` for the quality
bar, `apps/web/BRIEF.md` for the design bar, `docs/ops.md` for the backup/
restore runbook, and `README.md` for development and deployment steps.

Status: ratified by Allen 2026-07-02 (design chat). Amendments require Allen.

## Problem and solution

Self-contained HTML reports need a publishing home that is CLI-first (usable by
humans and agents), identity-gated with per-page visibility, self-hosted, and
presentable. press is a One (OneStack) web app + Postgres + flat-file blob store,
plus a `press` CLI. Identity is Better Auth (Google in production, seeded
email/password credentials in localnet/test). Authorization is press's own ACL
layer. Published pages are served under `/p/` with a sandboxing CSP so reports
cannot attack their readers or each other.

## Architecture

- **Monorepo** (this repo, from typescript-template): `apps/web` = One app
  (server + UI), `packages/cli` = the `press` CLI. Bun workspaces, nub runner,
  tsgo/oxlint/oxfmt gates.
- **apps/web**: One file-based routes. UI routes (`/`, `/c/:collection`,
  `/login`) render the magazine surface. API routes (`+api.ts`, plain
  Request→Response handlers) implement auth, publish, and serving. Tamagui UI,
  patterns grafted from a reference monorepo (Better Auth wiring, Drizzle
  setup, upload route shape). Zero sync, native targets, SST,
  hot-updater are explicitly not grafted.
- **Data**: Postgres via Drizzle (users/sessions/tokens, collections, pages,
  audit). Blobs are flat files under `PRESS_STORAGE_DIR/<collection>/<file>`;
  the DB row is the source of truth for existence and ACL.
- **Deployment**: single container image + Postgres. Instance manifests and
  the registry mirror live outside this repo, operator-managed (TLS via
  ingress/cert-manager).

## Domain model

```
User        (Better Auth) id, email, role: 'user' | 'admin'
Session     (Better Auth) cookie-backed, HttpOnly
ApiToken    (Better Auth api-key or equivalent) hashed, revocable, userId,
            name, lastUsedAt
Collection  slug PK, ownerId → User, title?,
            defaultVisibility: 'default' | 'public' | 'private', createdAt
Page        id, collectionSlug → Collection, fileSlug, title (extracted),
            visibility: 'default' | 'public' | 'password' | 'private',
            passwordHash? (argon2), allowlist: email[], contentHash (sha256),
            sizeBytes, publishedBy → User, publishedAt, updatedAt,
            archivedAt?
PageRedirect sourceCollectionSlug → Collection, sourceFileSlug,
            targetPageId → Page, kind: 'permanent', createdBy → User,
            createdAt; source path unique
AuditEvent  id, userId, action: 'publish' | 'overwrite' | 'unpublish' |
            'visibility-change' | 'password-reroll' | 'token-revoke' | 'move',
            collectionSlug, fileSlug?, contentHash?, details?, createdAt
```

Slug grammar (both collection and file slugs):

- collection: `^[a-z0-9][a-z0-9-]{0,62}$`, minus a reserved list
  (`api`, `p`, `c`, `login`, `logout`, `cli`, `assets`, `admin`, `docs`)
- file: `^[a-z0-9][a-z0-9._-]{0,120}\.html$`, and must not contain `..`

## Requirements

### AUTH — identity

- **REQ-AUTH-001** Production sign-in is Google via Better Auth social provider;
  the Google OAuth client credentials exist only server-side.
- **REQ-AUTH-002** Localnet/test sign-in is Better Auth email/password
  (credential) provider with seeded users. The provider is enabled only when
  `PRESS_ENABLE_CREDENTIAL_AUTH=1`; the server refuses to boot if that flag is
  set while `NODE_ENV=production` (fail-closed). Re-running the localnet seed is
  idempotent: seed-owned page identities, canonical paths, bytes, and redirect
  state are restored even after a demo page has moved.
- **REQ-AUTH-003** Browser sessions are HttpOnly, Secure (in prod), SameSite=Lax
  cookies via Better Auth.
- **REQ-AUTH-004** The CLI authenticates with a press-issued API token. Default
  `press login` runs a browser-loopback flow (CLI opens `BASE_URL/cli/authorize`
  with a loopback port + PKCE-style one-time challenge + state nonce; the server
  records a pending login bound to the session, port, challenge, and state, and
  renders a same-origin approval page whose form carries a server-generated
  consent token; only a CSRF-protected POST to `/cli/approve` presenting that
  token from the same session mints the one-time code, then the server
  redirects to `127.0.0.1:<port>` with the code and the bound state; the CLI
  exchanges the code for a long-lived API token). The exchange endpoint is
  testable without a real browser. (Consent step ratified 2026-08-11, B-1.)
  `press login --device` is an opt-in second front door (RFC 8628-shaped, not a
  general OAuth authorization server): the CLI POSTs a PKCE challenge to
  `/api/cli/device/start` and receives a high-entropy device secret, a short
  user code, a same-origin verification URI (`/cli/activate`), expiry, and poll
  interval; a signed-in browser confirms the user code and clicks Approve on a
  CSRF-protected same-origin POST (GET never claims or mints; a session cookie
  never returns the API token); the CLI polls `/api/cli/device/poll` with the
  device secret and PKCE verifier until success or `authorization_pending` /
  `slow_down` / `access_denied` / `expired_token`. Poll-before-approve does not
  mint. Default `press login` remains loopback; a missing browser/`open`/DISPLAY
  prints a hint only and does not auto-switch. (Device door ratified 2026-08-15.)
- **REQ-AUTH-005** API tokens are stored hashed server-side, are revocable
  (`press logout` revokes; users can revoke any of their tokens), and record
  lastUsedAt.
- **REQ-AUTH-006** CLI token resolution order: OS keychain (macOS Keychain
  Services), then the host-scoped 0600 file store at
  `$XDG_CONFIG_HOME/press/tokens.json` (default `~/.config/press/tokens.json`)
  when no usable OS keychain exists, then `PRESS_TOKEN` env var (for CI/agents,
  injected by a secret manager). The CLI never accepts the token as a command
  argument and never prints a minted token. The XDG file store is last-resort
  persistence for hosts without a usable OS keychain (directory mode 0700, file
  mode 0600). The `PRESS_E2E_KEYCHAIN_FILE` seam remains test-build-only.
- **REQ-AUTH-007** Instance admins are the users whose emails appear in
  `PRESS_ADMIN_EMAILS`. The config list is authoritative and enforced at every
  authorization use (sign-in assigns, tokens/sessions/whoami re-derive); removing
  an email demotes immediately — the stored role column is only a cache.
- **REQ-AUTH-008** The `/login` identity gate always renders the sign-in
  affordance for every enabled provider — the credential form when
  `PRESS_ENABLE_CREDENTIAL_AUTH=1` (localnet), the "Continue with Google" button
  when the Google client is configured (prod) — and never renders as copy-only
  with no way in. For a reader who cannot sign in it states that access follows
  their organization account and to ask the page's publisher. On localnet
  (credential provider enabled) it shows a seeded-account hint. A running
  instance with zero enabled providers is a fail-closed config error
  (REQ-CFG-002), not a silent dead-end.

### ACL — authorization

- **REQ-ACL-001** Page read access by visibility:
  | visibility | who may read |
  |---|---|
  | `public` | anyone, no auth |
  | `default` | authenticated user with email domain ∈ `PRESS_ALLOWED_DOMAINS`; also owner, admin |
  | `private` | authenticated user with email ∈ page allowlist; also owner, admin |
  | `password` | HTTP Basic auth matching the page's argon2 hash; also owner, admin (session) |
- **REQ-ACL-002** Unauthenticated browser requests (Accept: text/html) to
  `default`/`private` pages 302-redirect to `/login?next=<url>`; non-HTML
  requests receive 401. Authenticated-but-forbidden receives 403. `password`
  pages: an HTML request without a valid page-password credential renders the
  branded password-entry page (REQ-SRV-004) at 200 with no content leak; a
  non-HTML (programmatic/CLI) request is challenged with `WWW-Authenticate: Basic
realm="press"` and 401. Both channels resolve the same password-verified viewer
  channel through the single ACL function (REQ-ACL-006).
- **REQ-ACL-003** Page visibility = page-level value if set, else the
  collection's `defaultVisibility`, else `default`.
- **REQ-ACL-004** Private allowlists are exact email matches and may include
  addresses outside `PRESS_ALLOWED_DOMAINS` (external sharing).
- **REQ-ACL-005** Only the collection owner may publish into, overwrite, move
  from, unpublish from, or change visibility/allowlist/password within a
  collection. A cross-collection move may enter only a collection owned by the
  same user, or create its unknown destination collection for that user.
  Admins may additionally unpublish (moderation) but may not publish into
  or move another user's page.
- **REQ-ACL-006** The ACL decision is implemented as a pure function
  `(viewer, page, collection, config) → allow | deny(reason)` with unit tests
  covering the full matrix; all read/mutation paths call it.

### PUB — publish API

All mutation endpoints authenticate via `Authorization: Bearer <api token>`
ONLY. Session cookies never authorize mutations (CSRF-immune by construction).

- **REQ-PUB-001** `PUT /api/pages/:collection/:file` with `Content-Type:
text/html` body publishes a page. First publish to an unknown collection slug
  creates the collection with the caller as owner. Optional query params:
  `visibility`, `allow` (csv emails), `title` (override).
- **REQ-PUB-002** Validation: slugs must match the slug grammar (400 otherwise);
  body ≤ `PRESS_MAX_UPLOAD_BYTES` (default 25 MiB; 413 otherwise); content-type
  must be text/html (415 otherwise).
- **REQ-PUB-003** Non-owner publish into an existing collection → 403.
  Overwrite by the owner is allowed and audited; v1 keeps no version history
  (the audit row records the new contentHash).
- **REQ-PUB-004** On publish the server extracts `<title>` (fallback: file
  slug), stores the blob at `PRESS_STORAGE_DIR/<collection>/<file>`, and writes
  the Page row and AuditEvent in the same transaction; blob write is fsynced
  before the transaction commits. Response JSON: `{ url, collection, file,
title, visibility, password?, allow? }` — `allow` is the page's resolved
  allowlist (present for `private` pages) so the caller can confirm exactly who
  was granted.
- **REQ-PUB-005** `visibility=password`: when the publisher supplies no password,
  the server generates a strong random one. A publisher MAY instead supply a
  custom password (≥ 8 characters; 400 otherwise), delivered only through a
  non-argv channel — a request body/header field the CLI populates from an
  interactive hidden prompt, `PRESS_PAGE_PASSWORD`, or stdin — never an argv value
  and never logged (INV-4). Either way the server stores only the argon2 hash and
  returns the effective password exactly once in the publish response.
  `POST /api/pages/:collection/:file/password` re-rolls a random password or sets
  a new custom one (owner only).
- **REQ-PUB-006** `PATCH /api/pages/:collection/:file` updates visibility /
  allowlist / title (owner only). `PATCH /api/collections/:collection` updates
  defaultVisibility / title (owner only). `defaultVisibility` accepts only
  `default | public | private`; `password` is page-explicit because its
  server-generated material (one-time password, argon2 hash — REQ-PUB-005) is
  per-page and cannot be supplied by collection inheritance. Requests offering
  `password` as a collection default receive 400.
- **REQ-PUB-007** `DELETE /api/pages/:collection/:file` soft-deletes: sets
  archivedAt, moves the blob to an archive dir, removes the page from all
  indexes and serving (404). Owner or admin.
- **REQ-PUB-008** `GET /api/collections` and `GET
/api/collections/:collection/pages` list only what the caller may read
  (REQ-ACL-001 applied with the token's user as viewer).
- **REQ-PUB-009** Every mutation writes an AuditEvent row; admin moderation
  actions are audited with the admin's identity.
- **REQ-PUB-010** `POST /api/pages/:collection/:file/move` with JSON
  `{ collection, file, redirect?: 'permanent' | 'none' }` moves a live source
  page to a different canonical path. `redirect` defaults to `permanent`.
  Content bytes, title, content hash, size, password hash, allowlist, publisher,
  and original publication time are preserved. A cross-collection move
  materializes the source page's resolved visibility so the destination
  collection default cannot widen or narrow its ACL. The destination appears
  in indexes and lists; the source does not.
- **REQ-PUB-011** A move validates both paths, authenticates per INV-1, locks
  source and destination in deterministic order, moves the blob, updates the
  page and optional redirect, and writes one attributed `move` AuditEvent with
  source, destination, redirect mode, and content hash. Database/audit failure
  restores the source row and blob while retaining exclusion on both paths
  through filesystem compensation. A live destination or redirect source
  owned by another page returns 409 without changing the source. An archived
  destination is reclaimable, matching republish behavior. Moving back to a
  redirect source of the same page consumes that redirect.

### SRV — serving published pages

- **REQ-SRV-001** `GET /p/:collection/:file` streams the blob after the ACL
  check. The filesystem path is constructed only from the DB row's validated
  slugs — never from raw URL input.
- **REQ-SRV-002** Every `/p/` response — except the REQ-SRV-004 password entry page,
  the sole exception — carries:
  `Content-Security-Policy: sandbox allow-scripts allow-popups`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`. (Sandbox ⇒ opaque origin: report JS cannot read
  cookies/storage, and its fetches to press are cross-origin and
  uncredentialed — reports cannot read other reports or act as their viewer.)
- **REQ-SRV-003** Archived or unknown pages return 404 (not 403 — do not leak
  existence to unauthorized viewers either: failed ACL on an existing
  `private`/`default` page returns 403 only when the viewer is authenticated;
  anonymous non-HTML gets 401 per REQ-ACL-002).
- **REQ-SRV-004** The branded password-entry page (HTML request to a `password`
  page with no valid credential) renders press chrome, the page title, and a
  password form that POSTs to `POST /p/:collection/:file` (form-encoded
  `password`). On a correct password the server sets a page-scoped, HttpOnly,
  SameSite=Lax, Secure-in-prod, short-TTL signed cookie authorizing only that one
  page, then 303-redirects to the GET, which serves the blob; on a wrong password
  it re-renders the page with an error at 401. This read-side unlock is not a page
  mutation — INV-1 (mutations are Bearer-only) is unaffected. The entry page never
  contains the report body before unlock and holds the web design floors
  (`apps/web/BRIEF.md`). It is press's own trusted chrome, so it carries a strict CSP
  (`default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none';
frame-ancestors 'none'`) rather than the report sandbox of REQ-SRV-002 — that sandbox
  omits `allow-forms` and would block the unlock form. Basic auth (REQ-ACL-002) remains
  the programmatic channel.
- **REQ-SRV-005** When no live page exists at a valid `/p/:collection/:file`
  path, `GET` checks for an active permanent redirect. A redirect resolves by
  stable target page identity and returns 308 with `Location` set to that
  page's current canonical `/p/` path and the REQ-SRV-002 headers, without
  reading or returning report bytes. Redirect lookup is public; the destination
  performs its normal ACL check. Repeated moves therefore flatten to the
  current canonical path rather than forming chains. A missing or archived
  target returns 404, and unpublishing a target makes all of its old paths 404.

### IDX — indexes / news surface

- **REQ-IDX-001** `/` renders the magazine feed: readable pages across all
  collections, newest first, each entry showing title, collection, publisher,
  and date. The feed is filtered through REQ-ACL-001 for the current viewer
  (anonymous sees only `public`).
- **REQ-IDX-002** `/c/:collection` renders a collection index with the same ACL
  filtering; unknown collection or one with zero readable pages → 404.
- **REQ-IDX-003** `password` pages are listed (title + lock affordance) to
  viewers who satisfy the org-domain gate, and hidden from anonymous viewers.

### CLI — packages/cli, bin `press`

- **REQ-CLI-001** Commands: `press login [--device] [--host <url>]`, `press logout`,
  `press whoami`, `press publish <file> --to <collection> [--as <file-slug>]
[--visibility <v>] [--allow <emails>] [--password]`, `press list [collection]`,
  `press page set <collection>/<file> [--visibility <v>] [--allow <emails>]
[--password]`, `press move <source> <destination> [--redirect permanent|none]`,
  `press unpublish <collection>/<file>`. `--password` is a
  value-less flag: it triggers a hidden interactive prompt, or reads
  `PRESS_PAGE_PASSWORD`/stdin when non-interactive — the password never appears as
  an argv value (INV-4). `--allow` takes a comma-separated email list.
- **REQ-CLI-002** `--json` on every command emits machine-readable output for
  agent use; exit codes: 0 success, 1 error, 2 auth required, 3 forbidden.
- **REQ-CLI-003** The default host is baked per-instance via `PRESS_HOST` env or
  `--host`; the CLI stores tokens per-host in the keychain (service name
  `press:<host>`).
- **REQ-CLI-004** `press publish` prints the final URL. For a `password` page it
  also prints the effective password once plus one line of reader guidance (share
  the link; the reader opens it and enters the password on the branded entry page
  of REQ-SRV-004). For a `private` page it echoes the resolved allowlist so the
  publisher can confirm who was granted. `--json` output includes `allow` and
  stays machine-clean (no guidance prose).
- **REQ-CLI-005** `press move <source-collection/source-file>
<destination-collection/destination-file> [--redirect permanent|none]`
  defaults to a permanent redirect. Human output prints the old URL, new URL,
  and redirect mode. `--json` returns both paths/URLs, the redirect mode, title,
  and resolved visibility in the standard machine-clean envelope.
- **REQ-CLI-006** Each semver release produces standalone `press` executables
  for macOS arm64 and Linux x64 that run without Bun, a source checkout, or
  runtime workspace files. `press --version` prints exactly the CLI package and
  release version. Each platform archive contains one executable named `press`
  at its root, and the release includes SHA-256 checksums for every archive.
  Compiled executables do not auto-load ambient `.env` files or `bunfig.toml`.
  The packaged-binary gate runs `doctor --json` and the real CLI e2e flows
  through the compiled executable; source-entrypoint tests remain only the fast
  parser/unit layer.

### CFG — instance configuration

- **REQ-CFG-001** All org-specific values are env config, none hardcoded:
  `PRESS_BASE_URL`, `PRESS_ALLOWED_DOMAINS` (csv, ≥1 in prod),
  `PRESS_ADMIN_EMAILS` (csv), `DATABASE_URL`, `PRESS_STORAGE_DIR`,
  `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (prod),
  `PRESS_ENABLE_CREDENTIAL_AUTH` (localnet only), `PRESS_MAX_UPLOAD_BYTES`,
  `PRESS_MAX_METADATA_BYTES`.
- **REQ-CFG-002** Config is validated at boot; missing/invalid required values
  abort startup with a descriptive error (fail loudly).

## Invariants

- **INV-1** Mutations authenticate solely via Bearer API tokens; a session
  cookie alone never authorizes a mutation.
- **INV-2** Every `/p/` response carries the sandbox CSP of REQ-SRV-002, except the
  branded password entry page (REQ-SRV-004) — the sole exception — which carries its
  own strict, form-capable CSP (no scripts, no report body, `form-action 'self'`).
- **INV-3** Served file paths derive only from DB-validated slugs.
- **INV-4** No secret value ever appears in argv, logs, or the repo. Page
  passwords exist in plaintext only inside the single publish/re-roll response.
- **INV-5** Credential auth cannot be enabled in production (boot refusal).
- **INV-6** Every mutation and its audit row commit in one transaction.
- **INV-7** Every read/mutation authorization decision flows through the single
  pure ACL function (REQ-ACL-006).

## Non-goals (v1)

Native apps; realtime/Zero sync; S3/object-store blobs; page version history;
multi-file/tarball uploads; identity providers beyond Google + localnet
credentials; quotas/billing; full-text search; comments/reactions; npm
distribution of the CLI; in-app HTML authoring or editing; temporary redirects;
standalone redirect creation, listing, or removal; a general OAuth authorization
server (`client_id`, `grant_type`, third-party device clients); auto-selecting
device-code login; replacing the macOS Keychain backend with `Bun.secrets`.

## Risk tags

- **HIGH (auth/security boundary):** the entire AUTH/ACL/SRV surface. Approved
  in design (Allen, 2026-07-02); implementation still gates on the e2e matrix.
- **HIGH (public API contract):** the publish API and CLI verbs — agents and
  skills (gh-pulse rituals) will build against them.
- **HIGH (release/runtime contract):** standalone CLI platform support, archive
  layout, checksums, and version identity are installation contracts consumed by
  installation tooling; native-platform release jobs verify advertised artifacts.
- **HIGH (schema migration):** page redirects and structured move audit details
  are Drizzle-managed and additive in v1; migration verification runs before
  the feature is called done.

## Acceptance criteria

The e2e ACL matrix (run against localnet; see `BRIEF.md` floors):

- [ ] Anonymous GET of a `public` page → 200 with sandbox CSP
- [ ] Anonymous browser GET of a `default` page → 302 to /login; non-HTML → 401
- [ ] Authenticated wrong-domain user GET of a `default` page → 403
- [ ] Authenticated allowed-domain user GET of a `default` page → 200
- [ ] `private` page: allowlisted external user → 200; non-allowlisted
      same-domain user → 403; owner → 200
- [ ] `password` page: non-HTML no credentials → 401 + Basic challenge; correct
      Basic password → 200; HTML no credentials → 200 branded entry page with no
      body leak; POST correct password → cookie + 303 → 200; POST wrong password
      → 401 re-render; owner session → 200 (REQ-SRV-004)
- [ ] `visibility=password` with a publisher-supplied custom password (≥ 8 chars,
      via prompt/env/stdin — never argv) unlocks; a < 8-char password → 400
      (REQ-PUB-005)
- [ ] `press publish` never places a page password in argv; a password page prints
      reader guidance, a private page echoes the resolved allowlist; `--json`
      carries `allow` (REQ-CLI-004, REQ-PUB-004)
- [ ] `/login` renders the enabled provider affordance in both localnet
      (credential form + seeded hint) and Google-configured modes, and is never
      copy-only (REQ-AUTH-008)
- [ ] Every `/p/` 200 serving report content carries the exact CSP of REQ-SRV-002;
      the password entry page (REQ-SRV-004) instead carries its strict form-capable
      CSP (no scripts, no report body)
- [ ] `press login --device` (real compiled CLI) prints a verification URI and
      user code only (never the device secret or API token), completes after a
      signed-in browser Approve on `/cli/activate`, exits 0, and a subsequent
      `press whoami` in a fresh process returns the signed-in email. Poll before
      approve does not mint. Default `press login` remains loopback
      (REQ-AUTH-004, REQ-AUTH-006, REQ-CLI-001)
- [ ] `press publish` (real CLI binary) creates a collection, publishes, prints
      URL; republish overwrites; second user's publish to same collection → 403
      (exit 3)
- [ ] The packaged macOS arm64 and Linux x64 executables report the release
      version, run `doctor --json` without Bun or a checkout on `PATH`, and are
      shipped as one-root-file archives with matching SHA-256 checksums
- [ ] `nub run e2e` and `nub run walkthrough` spawn the compiled executable,
      not `packages/cli/src/index.ts`
- [ ] `visibility=password` publish returns a password exactly once; hash-only
      in DB
- [ ] `press unpublish` archives; subsequent GET → 404; feed no longer lists it
- [ ] `press move old new` preserves bytes, metadata, publication time, and ACL;
      lists show only `new`; `old` → 308 with `Location: new`; the destination
      applies its original read gate
- [ ] `press move old new --redirect none` makes `old` → 404; a live page or
      another page's redirect at `new` returns 409 without losing the source
- [ ] Cross-collection move preserves effective visibility, rejects a
      destination collection owned by someone else, and lets the owner create a
      new destination collection
- [ ] Repeated moves flatten all prior redirects to the current canonical path;
      unpublishing the target makes every alias 404; moving back consumes the
      same-page redirect at the destination
- [ ] Move storage evidence shows the source blob absent, destination blob hash
      equal to `page.contentHash`, and source restoration after injected
      database/audit failure
- [ ] Feed as anonymous shows only public entries; as domain user shows
      default+public+own-private; entries ordered newest-first
- [ ] Publish with traversal-shaped file name (`../evil.html`, `a..b.html`,
      encoded slashes) → 400, nothing written
- [ ] Boot with `PRESS_ENABLE_CREDENTIAL_AUTH=1` and `NODE_ENV=production` →
      refuses to start
- [ ] Every mutation in the suite has a matching AuditEvent row

## Test traceability

| Requirement                                   | Test file(s) / test name                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| REQ-CFG-001                                   | `packages/core/src/config.test.ts:22` returns typed config; `packages/core/src/config.test.ts:64` requires production-only config; `scripts/smokeImage.ts` image env refusal                                                                                                                                                                           |
| REQ-CFG-002                                   | `packages/core/src/config.test.ts:38` requires core boot variables; `apps/web/src/server/config.test.ts:18` wraps config failures; `e2e/publish.spec.ts:780`; `scripts/smokeImage.ts` image boot refusal                                                                                                                                               |
| REQ-AUTH-001                                  | `packages/core/src/config.test.ts:64` requires production-only config; `apps/web/src/server/config.test.ts:59` registers Google provider                                                                                                                                                                                                               |
| REQ-AUTH-002                                  | `apps/web/src/server/config.test.ts:41` credential provider gating; `e2e/auth.spec.ts:5`; `e2e/publish.spec.ts` moved-demo reseed idempotency; `e2e/publish.spec.ts:780`; `scripts/smokeImage.ts` production image refusal                                                                                                                             |
| REQ-AUTH-003                                  | `e2e/auth.spec.ts:5` credential provider signs in a seeded localnet user                                                                                                                                                                                                                                                                               |
| REQ-AUTH-004                                  | `e2e/cli.spec.ts` loopback login; `apps/web/src/auth/cliDeviceFlow.test.ts` device start/activate/poll; `e2e/cli.spec.ts` compiled `--device` happy path                                                                                                                                                                                               |
| REQ-AUTH-005                                  | `e2e/cli.spec.ts:227` token logout/revoke; `e2e/publish.spec.ts:161` token lastUsedAt                                                                                                                                                                                                                                                                  |
| REQ-AUTH-006                                  | `e2e/cli.spec.ts` keychain-backed token flow and `PRESS_TOKEN` fallback; `packages/cli/src/keychain.test.ts` XDG file-store last resort                                                                                                                                                                                                                |
| REQ-AUTH-007                                  | `packages/core/src/config.test.ts:22` admin email config; `e2e/publish.spec.ts:270` admin unpublish path                                                                                                                                                                                                                                               |
| BRIEF Decision (Better Auth rate limiting on) | `e2e/rateLimit.spec.ts:147` credential sign-in is rate limited by endpoint on an isolated server                                                                                                                                                                                                                                                       |
| REQ-ACL-001                                   | `packages/core/src/acl.test.ts:142` decideAcl read matrix; `e2e/publish.spec.ts:512`, `:589`, `:612`, `:635`, `:666`                                                                                                                                                                                                                                   |
| REQ-ACL-002                                   | `apps/web/src/publish/serveAcl.test.ts:23` deniedAclResponse; `e2e/publish.spec.ts:556`, `:589`, `:666`                                                                                                                                                                                                                                                |
| REQ-ACL-003                                   | `packages/core/src/acl.test.ts:164` visibility fallback; `apps/web/src/db/schema.test.ts:36`; `e2e/publish.spec.ts:270`                                                                                                                                                                                                                                |
| REQ-ACL-004                                   | `packages/core/src/acl.test.ts:192` private allowlists; `e2e/publish.spec.ts:635`                                                                                                                                                                                                                                                                      |
| REQ-ACL-005                                   | `packages/core/src/acl.test.ts` mutation matrix (including move); `e2e/publish.spec.ts` page-move guard scenarios                                                                                                                                                                                                                                      |
| REQ-ACL-006                                   | `packages/core/src/acl.test.ts:142`; `apps/web/src/db/schema.test.ts:36`; `apps/web/src/publish/serveAcl.test.ts:67`; `e2e/publish.spec.ts:512`                                                                                                                                                                                                        |
| REQ-PUB-001                                   | `e2e/publish.spec.ts:161` publish endpoint enforces bearer auth, validation, storage, overwrite, and audit                                                                                                                                                                                                                                             |
| REQ-PUB-002                                   | `packages/core/src/slug.test.ts:10`, `:27` slug grammar; `e2e/publish.spec.ts:161` validation                                                                                                                                                                                                                                                          |
| REQ-PUB-003                                   | `packages/core/src/acl.test.ts:236` mutations; `e2e/publish.spec.ts:161`; `e2e/cli.spec.ts:227`                                                                                                                                                                                                                                                        |
| REQ-PUB-004                                   | `e2e/publish.spec.ts:161` publish response/storage/audit; `e2e/publish.spec.ts:817` rollback restores previous blob                                                                                                                                                                                                                                    |
| REQ-PUB-005                                   | `apps/web/src/publish/passwords.test.ts:5`; `e2e/publish.spec.ts:270`; `e2e/cli.spec.ts:227`                                                                                                                                                                                                                                                           |
| REQ-PUB-006                                   | `packages/core/src/acl.test.ts:236`; `e2e/publish.spec.ts:270`; `e2e/cli.spec.ts:227`                                                                                                                                                                                                                                                                  |
| REQ-PUB-007                                   | `packages/core/src/acl.test.ts:236`; `e2e/publish.spec.ts:724`; `e2e/cli.spec.ts:227`                                                                                                                                                                                                                                                                  |
| REQ-PUB-008                                   | `e2e/publish.spec.ts:270`; `e2e/publish.spec.ts:724`; `e2e/cli.spec.ts:227`                                                                                                                                                                                                                                                                            |
| REQ-PUB-009                                   | `e2e/publish.spec.ts:119` expectAudit helper coverage; `e2e/publish.spec.ts:161`, `:270`, `:724`, `:817`; `e2e/cli.spec.ts:227`                                                                                                                                                                                                                        |
| REQ-PUB-010                                   | `apps/web/src/publish/responseShape.test.ts` move response; `e2e/publish.spec.ts` canonical-path/ACL move flow; `e2e/cli.spec.ts` real CLI move flow                                                                                                                                                                                                   |
| REQ-PUB-011                                   | `apps/web/src/publish/pagePathLocks.test.ts` deterministic session-lock/compensation order; `apps/web/src/publish/storage.test.ts` move/rollback/collision; `apps/web/src/db/schema.test.ts` redirect shape; `e2e/publish.spec.ts` guard, archive-reclaim, audit, and forced-failure rollback flow                                                     |
| REQ-SRV-001                                   | `e2e/publish.spec.ts:512`, `:589`, `:612`, `:635`, `:666`, `:724`; `scripts/smokeImage.ts` image-served public page                                                                                                                                                                                                                                    |
| REQ-SRV-002                                   | `apps/web/src/publish/serveAcl.test.ts:17` served headers; `e2e/publish.spec.ts:512`; `scripts/smokeImage.ts` image CSP byte-compare                                                                                                                                                                                                                   |
| REQ-SRV-003                                   | `apps/web/src/publish/serveAcl.test.ts:23` denied responses; `e2e/publish.spec.ts:724`                                                                                                                                                                                                                                                                 |
| REQ-SRV-005                                   | `e2e/publish.spec.ts` permanent redirect, flattening, move-back, and unpublish lifecycle; `scripts/agentWalkthrough.ts` real CLI redirect dogfood                                                                                                                                                                                                      |
| REQ-IDX-001                                   | `e2e/magazine.spec.ts:30`, `:47`, `:62`; `e2e/smoke.spec.ts:75`; `scripts/smokeImage.ts` image feed shell                                                                                                                                                                                                                                              |
| REQ-IDX-002                                   | `e2e/magazine.spec.ts:77`; `e2e/smoke.spec.ts:75`                                                                                                                                                                                                                                                                                                      |
| REQ-IDX-003                                   | `e2e/magazine.spec.ts:47`; `e2e/magazine.spec.ts:77`; `e2e/smoke.spec.ts:238`                                                                                                                                                                                                                                                                          |
| REQ-CLI-001                                   | `e2e/cli.spec.ts` loopback login; `packages/cli/src/index.test.ts` `--device` parse; `e2e/cli.spec.ts` compiled `--device` happy path                                                                                                                                                                                                                  |
| REQ-CLI-002                                   | `e2e/cli.spec.ts:227` `--json` success/error output and exit codes                                                                                                                                                                                                                                                                                     |
| REQ-CLI-003                                   | `e2e/cli.spec.ts:227` host-scoped token storage and `PRESS_TOKEN` fallback                                                                                                                                                                                                                                                                             |
| REQ-CLI-004                                   | `e2e/cli.spec.ts:227` publish URL and one-time password output                                                                                                                                                                                                                                                                                         |
| REQ-CLI-005                                   | `packages/cli/src/index.test.ts` move parsing/defaults; `e2e/cli.spec.ts` JSON + human output; `scripts/agentWalkthrough.ts` real login/CLI move flow                                                                                                                                                                                                  |
| REQ-CLI-006                                   | `packages/cli/src/index.test.ts` package-version identity; `scripts/cliRelease.test.ts` platform target/tag/archive/checksum contract; `scripts/verifyCliBinary.ts` no-Bun/no-checkout/config-autoload/package smoke; `e2e/cli.spec.ts` and `scripts/agentWalkthrough.ts` compiled flows; `.github/workflows/release.yml` native platform release gate |
