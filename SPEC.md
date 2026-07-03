# press — SPEC

The contract for press v1. See `VISION.md` for why, `BRIEF.md` for the quality
bar, `apps/web/BRIEF.md` for the design bar, and `loop.md` for the build plan.

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
  patterns grafted from Takeout v2 (`~/0xbigboss/tamagui/takeout2`): Better Auth
  wiring, Drizzle setup, upload route shape. Zero sync, native targets, SST,
  hot-updater are explicitly not grafted.
- **Data**: Postgres via Drizzle (users/sessions/tokens, collections, pages,
  audit). Blobs are flat files under `PRESS_STORAGE_DIR/<collection>/<file>`;
  the DB row is the source of truth for existence and ACL.
- **Deployment**: single container image (ghcr.io/unrulysystems/press) +
  Postgres. Instance manifests live outside this repo (send instance:
  `0xsend/press` mirrors image + holds manifests; Swiss cluster; TLS via
  cert-manager/ingress).

## Domain model

```
User        (Better Auth) id, email, role: 'user' | 'admin'
Session     (Better Auth) cookie-backed, HttpOnly
ApiToken    (Better Auth api-key or equivalent) hashed, revocable, userId,
            name, lastUsedAt
Collection  slug PK, ownerId → User, title?, defaultVisibility, createdAt
Page        id, collectionSlug → Collection, fileSlug, title (extracted),
            visibility: 'default' | 'public' | 'password' | 'private',
            passwordHash? (argon2), allowlist: email[], contentHash (sha256),
            sizeBytes, publishedBy → User, publishedAt, updatedAt,
            archivedAt?
AuditEvent  id, userId, action: 'publish' | 'overwrite' | 'unpublish' |
            'visibility-change' | 'password-reroll' | 'token-revoke',
            collectionSlug, fileSlug?, contentHash?, createdAt
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
  set while `NODE_ENV=production` (fail-closed).
- **REQ-AUTH-003** Browser sessions are HttpOnly, Secure (in prod), SameSite=Lax
  cookies via Better Auth.
- **REQ-AUTH-004** The CLI authenticates with a press-issued API token: `press
login` runs a browser-loopback flow (CLI opens `BASE_URL/cli/authorize` with a
  loopback port + PKCE-style one-time challenge; after the user authenticates,
  the server redirects to `127.0.0.1:<port>` with a one-time code; the CLI
  exchanges the code for a long-lived API token). The exchange endpoint is
  testable without a real browser.
- **REQ-AUTH-005** API tokens are stored hashed server-side, are revocable
  (`press logout` revokes; users can revoke any of their tokens), and record
  lastUsedAt.
- **REQ-AUTH-006** CLI token resolution order: OS keychain (macOS `security`),
  then `PRESS_TOKEN` env var (for CI/agents on non-mac hosts, injected by a
  secret manager). The CLI never writes the token to disk in plaintext and never
  accepts it as a command argument.
- **REQ-AUTH-007** Instance admins are the users whose emails appear in
  `PRESS_ADMIN_EMAILS` (role assigned at sign-in).

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
  pages challenge with `WWW-Authenticate: Basic realm="press"` and 401.
- **REQ-ACL-003** Page visibility = page-level value if set, else the
  collection's `defaultVisibility`, else `default`.
- **REQ-ACL-004** Private allowlists are exact email matches and may include
  addresses outside `PRESS_ALLOWED_DOMAINS` (external sharing).
- **REQ-ACL-005** Only the collection owner may publish into, overwrite,
  unpublish from, or change visibility/allowlist/password within a collection.
  Admins may additionally unpublish (moderation) but may not publish into
  another user's collection.
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
title, visibility, password? }`.
- **REQ-PUB-005** `visibility=password` causes the server to generate a strong
  random password, return it once in the publish response, and store only the
  argon2 hash. `POST /api/pages/:collection/:file/password` re-rolls (owner
  only). Publisher-chosen passwords are not supported.
- **REQ-PUB-006** `PATCH /api/pages/:collection/:file` updates visibility /
  allowlist / title (owner only). `PATCH /api/collections/:collection` updates
  defaultVisibility / title (owner only).
- **REQ-PUB-007** `DELETE /api/pages/:collection/:file` soft-deletes: sets
  archivedAt, moves the blob to an archive dir, removes the page from all
  indexes and serving (404). Owner or admin.
- **REQ-PUB-008** `GET /api/collections` and `GET
/api/collections/:collection/pages` list only what the caller may read
  (REQ-ACL-001 applied with the token's user as viewer).
- **REQ-PUB-009** Every mutation writes an AuditEvent row; admin moderation
  actions are audited with the admin's identity.

### SRV — serving published pages

- **REQ-SRV-001** `GET /p/:collection/:file` streams the blob after the ACL
  check. The filesystem path is constructed only from the DB row's validated
  slugs — never from raw URL input.
- **REQ-SRV-002** Every `/p/` response carries:
  `Content-Security-Policy: sandbox allow-scripts allow-popups`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`. (Sandbox ⇒ opaque origin: report JS cannot read
  cookies/storage, and its fetches to press are cross-origin and
  uncredentialed — reports cannot read other reports or act as their viewer.)
- **REQ-SRV-003** Archived or unknown pages return 404 (not 403 — do not leak
  existence to unauthorized viewers either: failed ACL on an existing
  `private`/`default` page returns 403 only when the viewer is authenticated;
  anonymous non-HTML gets 401 per REQ-ACL-002).

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

- **REQ-CLI-001** Commands: `press login [--host <url>]`, `press logout`,
  `press whoami`, `press publish <file> --to <collection> [--as <file-slug>]
[--visibility <v>] [--allow <emails>]`, `press list [collection]`,
  `press page set <collection>/<file> [--visibility <v>] [--allow <emails>]`,
  `press unpublish <collection>/<file>`.
- **REQ-CLI-002** `--json` on every command emits machine-readable output for
  agent use; exit codes: 0 success, 1 error, 2 auth required, 3 forbidden.
- **REQ-CLI-003** The default host is baked per-instance via `PRESS_HOST` env or
  `--host`; the CLI stores tokens per-host in the keychain (service name
  `press:<host>`).
- **REQ-CLI-004** `press publish` prints the final URL, and the one-time
  password when the server generated one.

### CFG — instance configuration

- **REQ-CFG-001** All org-specific values are env config, none hardcoded:
  `PRESS_BASE_URL`, `PRESS_ALLOWED_DOMAINS` (csv, ≥1 in prod),
  `PRESS_ADMIN_EMAILS` (csv), `DATABASE_URL`, `PRESS_STORAGE_DIR`,
  `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (prod),
  `PRESS_ENABLE_CREDENTIAL_AUTH` (localnet only), `PRESS_MAX_UPLOAD_BYTES`.
- **REQ-CFG-002** Config is validated at boot; missing/invalid required values
  abort startup with a descriptive error (fail loudly).

## Invariants

- **INV-1** Mutations authenticate solely via Bearer API tokens; a session
  cookie alone never authorizes a mutation.
- **INV-2** Every `/p/` response carries the sandbox CSP of REQ-SRV-002.
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
distribution of the CLI (repo install / `bun link` for now); in-app HTML
authoring or editing.

## Risk tags

- **HIGH (auth/security boundary):** the entire AUTH/ACL/SRV surface. Approved
  in design (Allen, 2026-07-02); implementation still gates on the e2e matrix.
- **HIGH (public API contract):** the publish API and CLI verbs — agents and
  skills (gh-pulse rituals) will build against them.
- Schema migrations: Drizzle-managed; additive in v1.

## Acceptance criteria

The e2e ACL matrix (run against localnet; see `BRIEF.md` floors):

- [ ] Anonymous GET of a `public` page → 200 with sandbox CSP
- [ ] Anonymous browser GET of a `default` page → 302 to /login; non-HTML → 401
- [ ] Authenticated wrong-domain user GET of a `default` page → 403
- [ ] Authenticated allowed-domain user GET of a `default` page → 200
- [ ] `private` page: allowlisted external user → 200; non-allowlisted
      same-domain user → 403; owner → 200
- [ ] `password` page: no credentials → 401 + Basic challenge; correct password
      → 200; wrong password → 401; owner session → 200
- [ ] Every `/p/` 200 in the suite carries the exact CSP of REQ-SRV-002
- [ ] `press publish` (real CLI binary) creates a collection, publishes, prints
      URL; republish overwrites; second user's publish to same collection → 403
      (exit 3)
- [ ] `visibility=password` publish returns a password exactly once; hash-only
      in DB
- [ ] `press unpublish` archives; subsequent GET → 404; feed no longer lists it
- [ ] Feed as anonymous shows only public entries; as domain user shows
      default+public+own-private; entries ordered newest-first
- [ ] Publish with traversal-shaped file name (`../evil.html`, `a..b.html`,
      encoded slashes) → 400, nothing written
- [ ] Boot with `PRESS_ENABLE_CREDENTIAL_AUTH=1` and `NODE_ENV=production` →
      refuses to start
- [ ] Every mutation in the suite has a matching AuditEvent row

## Test traceability

| Requirement  | Test file(s)                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| REQ-CFG-001  | `packages/core/src/config.test.ts`, `apps/web/src/server/config.test.ts`                                                          |
| REQ-CFG-002  | `packages/core/src/config.test.ts`, `apps/web/src/server/config.test.ts`, `e2e/publish.spec.ts`                                   |
| REQ-AUTH-002 | `apps/web/src/server/config.test.ts`, `e2e/auth.spec.ts`, `e2e/publish.spec.ts`                                                   |
| REQ-AUTH-003 | `e2e/auth.spec.ts`                                                                                                                |
| REQ-AUTH-004 | `apps/web/src/auth/cliFlow.ts`, `e2e/cli.spec.ts`                                                                                 |
| REQ-AUTH-005 | `apps/web/src/auth/apiTokens.ts`, `apps/web/src/auth/cliFlow.ts`, `e2e/cli.spec.ts`, `e2e/publish.spec.ts`                        |
| REQ-AUTH-006 | `packages/cli/src/index.ts`, `e2e/cli.spec.ts`                                                                                    |
| REQ-AUTH-007 | `apps/web/src/server/config.test.ts`, `e2e/auth.spec.ts`                                                                          |
| REQ-ACL-001  | `packages/core/src/acl.test.ts`, `e2e/publish.spec.ts`                                                                            |
| REQ-ACL-002  | `apps/web/src/publish/serveAcl.test.ts`, `e2e/publish.spec.ts`                                                                    |
| REQ-ACL-003  | `packages/core/src/acl.test.ts`, `apps/web/src/db/schema.test.ts`, `e2e/publish.spec.ts`                                          |
| REQ-ACL-004  | `packages/core/src/acl.test.ts`, `e2e/publish.spec.ts`                                                                            |
| REQ-ACL-005  | `packages/core/src/acl.test.ts`, `e2e/publish.spec.ts`                                                                            |
| REQ-ACL-006  | `packages/core/src/acl.test.ts`, `apps/web/src/db/schema.test.ts`, `apps/web/src/publish/serveAcl.test.ts`, `e2e/publish.spec.ts` |
| REQ-PUB-001  | `e2e/publish.spec.ts`                                                                                                             |
| REQ-PUB-002  | `packages/core/src/slug.test.ts`, `e2e/publish.spec.ts`                                                                           |
| REQ-PUB-003  | `packages/core/src/acl.test.ts`, `e2e/publish.spec.ts`                                                                            |
| REQ-PUB-004  | `e2e/publish.spec.ts`                                                                                                             |
| REQ-PUB-005  | `apps/web/src/publish/passwords.test.ts`, `e2e/publish.spec.ts`                                                                   |
| REQ-PUB-006  | `packages/core/src/acl.test.ts`, `e2e/publish.spec.ts`                                                                            |
| REQ-PUB-007  | `packages/core/src/acl.test.ts`, `e2e/publish.spec.ts`                                                                            |
| REQ-PUB-008  | `e2e/publish.spec.ts`                                                                                                             |
| REQ-PUB-009  | `e2e/publish.spec.ts`                                                                                                             |
| REQ-SRV-001  | `e2e/publish.spec.ts`                                                                                                             |
| REQ-SRV-002  | `apps/web/src/publish/serveAcl.test.ts`, `e2e/publish.spec.ts`                                                                    |
| REQ-SRV-003  | `apps/web/src/publish/serveAcl.test.ts`, `e2e/publish.spec.ts`                                                                    |
| REQ-IDX-001  | `apps/web/src/publish/indexes.ts`, `e2e/magazine.spec.ts`, `e2e/smoke.spec.ts`                                                    |
| REQ-IDX-002  | `apps/web/src/publish/indexes.ts`, `e2e/magazine.spec.ts`, `e2e/smoke.spec.ts`                                                    |
| REQ-IDX-003  | `apps/web/src/publish/indexes.ts`, `e2e/magazine.spec.ts`                                                                         |
| REQ-CLI-001  | `packages/cli/src/index.ts`, `e2e/cli.spec.ts`                                                                                    |
| REQ-CLI-002  | `packages/cli/src/index.ts`, `e2e/cli.spec.ts`                                                                                    |
| REQ-CLI-003  | `packages/cli/src/index.ts`, `e2e/cli.spec.ts`                                                                                    |
| REQ-CLI-004  | `packages/cli/src/index.ts`, `e2e/cli.spec.ts`                                                                                    |
