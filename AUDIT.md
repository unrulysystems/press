---
audit_version: 1
last_batch_id: 'uaudit-2026-07-03-ff6d8b'
last_run_at: '2026-07-03T15:48:18.269Z'
scope_paths:
  - '**'
last_scope_sha: '7be62bc6eed12ecde1df6ebc8c6a687f429e7388'
coverage:
  failed_personas: []
  partial_batch: false
finding_ledger:
  F-01:
    {
      'fingerprint': 'a57f98611b9ba8f05522b6ad843e3a320091847f501abf8f66f51f98215b3669',
      'status': 'open',
      'severity': 'high',
      'first_seen': 'uaudit-2026-07-03-ff6d8b',
      'last_verified': 'uaudit-2026-07-03-ff6d8b',
    }
  F-02:
    {
      'fingerprint': 'cbf3a5375250d332b40855f93ae42260af339a4303817d0e38877c52a483206b',
      'status': 'open',
      'severity': 'medium',
      'first_seen': 'uaudit-2026-07-03-ff6d8b',
      'last_verified': 'uaudit-2026-07-03-ff6d8b',
    }
  F-03:
    {
      'fingerprint': '971fe17388ef2f7089fac28e6573f45d16011b2374f561efd8709521be6617a0',
      'status': 'open',
      'severity': 'high',
      'first_seen': 'uaudit-2026-07-03-ff6d8b',
      'last_verified': 'uaudit-2026-07-03-ff6d8b',
    }
  F-04:
    {
      'fingerprint': 'ccb64f5ae1495654c4439dc3ca80c326dceb4764709c6bc0ea1c4f975c74cb68',
      'status': 'open',
      'severity': 'medium',
      'first_seen': 'uaudit-2026-07-03-ff6d8b',
      'last_verified': 'uaudit-2026-07-03-ff6d8b',
    }
  F-05:
    {
      'fingerprint': 'e4201b6d6473af4869743c9d134195e80747ba573d32505a86453329f18a2227',
      'status': 'open',
      'severity': 'high',
      'first_seen': 'uaudit-2026-07-03-ff6d8b',
      'last_verified': 'uaudit-2026-07-03-ff6d8b',
    }
  F-06:
    {
      'fingerprint': 'd6b580e406fe5a2f189e7997bba2c96df765809af7bfcc339e4312395ab7c875',
      'status': 'open',
      'severity': 'low',
      'first_seen': 'uaudit-2026-07-03-ff6d8b',
      'last_verified': 'uaudit-2026-07-03-ff6d8b',
    }
  F-07:
    {
      'fingerprint': 'ff79403c6ea61117205e08b80d1c649d89fdb8e0426167e172a2dd8c6cffcaaf',
      'status': 'open',
      'severity': 'high',
      'first_seen': 'uaudit-2026-07-03-ff6d8b',
      'last_verified': 'uaudit-2026-07-03-ff6d8b',
    }
  F-08:
    {
      'fingerprint': 'e3629979be2e6b134456505822dc7cf79168f1e006e71bf5741c7ea3fd86b3f8',
      'status': 'open',
      'severity': 'medium',
      'first_seen': 'uaudit-2026-07-03-ff6d8b',
      'last_verified': 'uaudit-2026-07-03-ff6d8b',
    }
  F-09:
    {
      'fingerprint': 'cdccce007da344ed6436b36b9ce13bd80a36336aa14d823356acb0e829177eb3',
      'status': 'open',
      'severity': 'low',
      'first_seen': 'uaudit-2026-07-03-ff6d8b',
      'last_verified': 'uaudit-2026-07-03-ff6d8b',
    }
  F-10:
    {
      'fingerprint': '2f8ff0b1eb8dd1ef5530e0a4dfbdac9c3077e3f477edf966cea8ef1c1ce71e33',
      'status': 'open',
      'severity': 'low',
      'first_seen': 'uaudit-2026-07-03-ff6d8b',
      'last_verified': 'uaudit-2026-07-03-ff6d8b',
    }
  F-11:
    {
      'fingerprint': 'b097a697d44113be2f0c383f8a21d33a389d1de3f1f38fa020b8b767d03c1f35',
      'status': 'open',
      'severity': 'low',
      'first_seen': 'uaudit-2026-07-03-ff6d8b',
      'last_verified': 'uaudit-2026-07-03-ff6d8b',
    }
---

# Audit - AUDIT.md

Scope: `**` at HEAD `7be62bc6ee` (last batch `uaudit-2026-07-03-ff6d8b`)

> **Driver status note (2026-07-03).** The ledger below shows all findings
> `open` because the confirmatory re-audit could not complete cleanly in this
> environment (see DELTA.md "phase 4 security re-audit"). The true state:
> **F-01, F-02, F-06, F-07, F-08, F-09, F-10, F-11 are FIXED** (commits
> `55f85af`, `a472783`, `f6df344`, `154f17a`, `17a7de3`; verified by 16 new
> regression tests, `nub run e2e` 81/81, live dev:share lifecycle checks, and
> an independent structured-review APPROVE on the phase-4 range).
> **F-03, F-04, F-05 are DEFERRED to Allen** (design/framework decisions;
> rationale and proposed fixes in `DEVIATIONS.md`) and remain genuinely
> unfixed. `resolved` is deliberately NOT set on any finding: that status is
> owned by a clean re-audit amendment, which should be re-run in CI or by
> Allen to authoritatively flip the eight fixed findings to `resolved`.

## Findings

### F-01 (high) - An admin impersonating another user can mint a long-lived API token for the impersonate...

**Fingerprint**: `a57f98611b9ba8f05522b6ad843e3a320091847f501abf8f66f51f98215b3669`
**Status**: open
**Location**: `apps/web/src/auth/cliFlow.ts:106-164`
**First anchor line**: 106

**Claim**: An admin impersonating another user can mint a long-lived API token for the impersonated user, bypassing the owner-only publish/overwrite/edit boundary for that user's collections.

**Evidence**: Better Auth admin creates a target-user session with `impersonatedBy` set to the admin at routes.mjs:585-588,596-601; getSession returns the joined session user at session.mjs:178,246-260. `cliAuthorizeEndpoint` stores `session.user.id` at apps/web/src/auth/cliFlow.ts:106,121-124; exchange mints an API token for that id at 157-164. Tokens have no expiry in apps/web/src/auth/apiTokens.ts:31-36 and authorize writes via routes.ts:359-367,411-434.

**Suggested fix**: Reject CLI authorization when `session.session.impersonatedBy` is present, or require token issuance to bind to the real actor rather than the impersonated user. Add a regression test covering impersonated sessions against `/cli/authorize` and `/api/cli/exchange`.

**Discovered by**: auth-and-authz
**First seen**: uaudit-2026-07-03-ff6d8b · **Last verified**: uaudit-2026-07-03-ff6d8b

---

### F-02 (medium) - A banned user with an existing press API token can continue authenticating to protected...

**Fingerprint**: `cbf3a5375250d332b40855f93ae42260af339a4303817d0e38877c52a483206b`
**Status**: open
**Location**: `apps/web/src/auth/apiTokens.ts:58-82`
**First anchor line**: 58

**Claim**: A banned user with an existing press API token can continue authenticating to protected CLI/API mutations because bearer-token verification ignores ban state.

**Evidence**: `verifyApiToken` reads Bearer, selects only tokenId/userId/email/role (apps/web/src/auth/apiTokens.ts:49-68), rejects only missing/revoked tokens (75-80), then returns the user (84-90). User ban fields exist (apps/web/src/db/schema.ts:38-40). Page PUT/PATCH/DELETE use this verifier before mutation ACL (apps/web/src/publish/routes.ts:359-395,480-496).

**Suggested fix**: Select `user.banned`/`user.banExpires` in `verifyApiToken` and return null for active bans. Also make the ban path revoke or invalidate existing `apiToken` rows for that user.

**Discovered by**: auth-and-authz
**First seen**: uaudit-2026-07-03-ff6d8b · **Last verified**: uaudit-2026-07-03-ff6d8b

---

### F-03 (high) - The CLI authorization endpoint mints a one-time code from a cookie-authenticated GET an...

**Fingerprint**: `971fe17388ef2f7089fac28e6573f45d16011b2374f561efd8709521be6617a0`
**Status**: open
**Location**: `apps/web/src/auth/cliFlow.ts:101-130`
**First anchor line**: 101

**Claim**: The CLI authorization endpoint mints a one-time code from a cookie-authenticated GET and redirects it to any requested loopback port, so a local attacker can obtain a victim's long-lived API token without an explicit user approval step.

**Evidence**: `cliFlow.ts:101-130` GETs session, accepts caller `port`/`challenge`, stores code for `session.user.id`, then redirects code to `127.0.0.1:${port}`. `cliFlow.ts:138-174` exchanges code+verifier for a returned API token. `schema.ts:96-108` token rows have revocation but no expiry.

**Suggested fix**: Require an authenticated approval screen with POST/CSRF before creating the CLI code, and bind the flow to a server-side nonce/state created before browser redirect. Keep PKCE, but do not issue codes from a bare GET with attacker-supplied loopback parameters.

**Discovered by**: auth-and-authz
**First seen**: uaudit-2026-07-03-ff6d8b · **Last verified**: uaudit-2026-07-03-ff6d8b

---

### F-04 (medium) - Session bearer tokens and OAuth provider tokens are modeled as plaintext database field...

**Fingerprint**: `ccb64f5ae1495654c4439dc3ca80c326dceb4764709c6bc0ea1c4f975c74cb68`
**Status**: open
**Location**: `apps/web/src/db/schema.ts:43-76`
**First anchor line**: 43

**Claim**: Session bearer tokens and OAuth provider tokens are modeled as plaintext database fields; a read of Postgres or its backups can expose replayable auth material rather than only hashes or encrypted blobs. This remains an accepted risk under the DEVIATIONS.md F-04 decision: Better Auth social requests strip client-supplied scopes server-side, Google is pinned to minimal identity-only scopes with no offline access, no refresh token is requested, and press does not read the stored provider tokens.

**Evidence**: schema.ts:43-49 defines `session.token` as unique `text`; schema.ts:61-72 defines `account.accessToken`, `refreshToken`, and `idToken` as `text`. auth/server.ts passes these tables to the Drizzle adapter, strips client `scopes` / `scope` values from `/sign-in/social` and `/link-social` before Better Auth creates the Google authorize URL, and keeps database-backed sessions enabled. providerConfig.ts pins Google to `openid`, `email`, `profile` without `accessType` or `prompt`. DEVIATIONS.md records the accepted-with-mitigation posture and keeps DB/backups classified as secret-bearing.

**Suggested fix**: The original hashing/column-drop fixes were consciously declined because they require Better Auth adapter overrides for marginal benefit after enforced scope minimization. Session bearer tokens remain Better Auth's default unhashed database values. Continue treating DB/backups as secret-bearing and rotate sessions after restore exposure.

**Discovered by**: secrets-and-keys
**First seen**: uaudit-2026-07-03-ff6d8b · **Last verified**: uaudit-2026-07-03-ff6d8b

---

### F-05 (high) - The CLI authorization endpoint lets an arbitrary local process mint a long-lived API to...

**Fingerprint**: `e4201b6d6473af4869743c9d134195e80747ba573d32505a86453329f18a2227`
**Status**: open
**Location**: `apps/web/src/auth/cliFlow.ts:101-164`
**First anchor line**: 101

**Claim**: The CLI authorization endpoint lets an arbitrary local process mint a long-lived API token from an existing browser session by choosing its own loopback port and challenge, opening /cli/authorize in the user's browser, receiving the redirected code on localhost, and exchanging it with its own verifier.

**Evidence**: `cliAuthorizeEndpoint` accepts authenticated GET, parses caller `port`/`challenge`, stores `userId`+challenge, then redirects code to `http://127.0.0.1:${port}` (`cliFlow.ts:101-130`). `cliExchangeEndpoint` requires only code+verifier, checks `hash(verifier)`, then returns a minted token (`cliFlow.ts:138-174`).

**Suggested fix**: Require an explicit same-origin approval step before issuing the code: create a server-owned pending CLI login with state/nonce, render a confirmation page, and issue the loopback redirect only after CSRF-protected POST approval.

**Discovered by**: ipc-and-sandbox
**First seen**: uaudit-2026-07-03-ff6d8b · **Last verified**: uaudit-2026-07-03-ff6d8b

---

### F-06 (low) - The press login loopback listener accepts the first /callback request containing any co...

**Fingerprint**: `d6b580e406fe5a2f189e7997bba2c96df765809af7bfcc339e4312395ab7c875`
**Status**: open
**Location**: `packages/cli/src/index.ts:288-357`
**First anchor line**: 288

**Claim**: The press login loopback listener accepts the first /callback request containing any code, so another same-host process can race the browser redirect with a bogus code and force the login attempt to fail before the real authorization completes.

**Evidence**: `Bun.serve` binds `127.0.0.1` and accepts any `/callback` with a nonempty `code`, immediately calling `resolveCode(code)` (`packages/cli/src/index.ts:288-302`). `commandLogin` exchanges only that raced code (`:340-346`); `apiFetch` throws on failed exchange (`:196-207`), and `finally` stops the listener (`:356-357`).

**Suggested fix**: Add an unguessable OAuth `state` value and require it on `/callback`. Ignore non-matching callbacks without resolving `codePromise`; keep the listener alive until a matching callback succeeds or the existing timeout expires.

**Discovered by**: ipc-and-sandbox
**First seen**: uaudit-2026-07-03-ff6d8b · **Last verified**: uaudit-2026-07-03-ff6d8b

---

### F-07 (high) - The scheduled dependency updater has contents: write, runs mutable third-party actions ...

**Fingerprint**: `ff79403c6ea61117205e08b80d1c649d89fdb8e0426167e172a2dd8c6cffcaaf`
**Status**: open
**Location**: `.github/workflows/update-deps.yml:8-55`
**First anchor line**: 8

**Claim**: The scheduled dependency updater has contents: write, runs mutable third-party actions and freshly updated dependencies, then pushes directly. A drifted action, Node index response, or package update can land release-affecting lock/toolchain changes on main without review.

**Evidence**: `.github/workflows/update-deps.yml:8-9` grants `contents: write`; `:18` runs `[REDACTED-SECRET]@main`; `:20` runs `nubjs/setup-nub@v0`; `:24-33` updates Node/npm/Nix; `:43-55` commits all changes and runs `git push`.

**Suggested fix**: Change the scheduled job to open a PR instead of pushing. Pin third-party actions to full commit SHAs, reduce default permissions, and require the normal check/test/e2e harness before merge.

**Discovered by**: supply-chain
**First seen**: uaudit-2026-07-03-ff6d8b · **Last verified**: uaudit-2026-07-03-ff6d8b

---

### F-08 (medium) - Migration integrity is tracked only by filename, not content. If a generated SQL migrat...

**Fingerprint**: `e3629979be2e6b134456505822dc7cf79168f1e006e71bf5741c7ea3fd86b3f8`
**Status**: open
**Location**: `apps/web/src/db/migrate.ts:10-38`
**First anchor line**: 10

**Claim**: Migration integrity is tracked only by filename, not content. If a generated SQL migration is edited after release, fresh databases apply the drifted SQL while existing databases skip it under the same id, producing release-dependent schema/runtime behavior.

**Evidence**: `apps/web/src/db/migrate.ts:12-14` creates `__press_migrations` with only `id` and `applied_at`. `:18-19` loads only ids into a Set. `:28-30` skips files whose filename was applied. `:34-38` executes current file contents and records only the filename, so changed SQL under the same filename is never compared.

**Suggested fix**: Add a checksum column for applied migrations, compute each SQL file checksum before execution, and fail closed when an existing id has a different checksum. Add CI/release policy to prevent editing applied migration files outside an explicit rewrite process.

**Discovered by**: supply-chain
**First seen**: uaudit-2026-07-03-ff6d8b · **Last verified**: uaudit-2026-07-03-ff6d8b

---

### F-09 (low) - The non-flake Nix fallback imports flake-compat from the moving `master.tar.gz` URL, by...

**Fingerprint**: `cdccce007da344ed6436b36b9ce13bd80a36336aa14d823356acb0e829177eb3`
**Status**: open
**Location**: `shell.nix:1-4`
**First anchor line**: 1

**Claim**: The non-flake Nix fallback imports flake-compat from the moving `master.tar.gz` URL, bypassing the pinned `flake.lock` entry. A changed upstream master can alter dev-shell evaluation for users of `nix-shell`.

**Evidence**: `shell.nix:2` imports `fetchTarball "https://github.com/edolstra/flake-compat/archive/master.tar.gz"`; no hash or commit is supplied. `flake.lock:3-11` pins a separate `flake-compat` input to rev `5edf11c...`, but `shell.nix:2-4` does not reference it.

**Suggested fix**: Pin the non-flake fallback too: use a commit-specific flake-compat archive with a hash, or rewrite `shell.nix` to consume the locked flake-compat source instead of `master.tar.gz`.

**Discovered by**: supply-chain
**First seen**: uaudit-2026-07-03-ff6d8b · **Last verified**: uaudit-2026-07-03-ff6d8b

---

### F-10 (low) - The dev-share flow mints an owner API token and persists the plaintext bearer token to ...

**Fingerprint**: `2f8ff0b1eb8dd1ef5530e0a4dfbdac9c3077e3f477edf966cea8ef1c1ce71e33`
**Status**: open
**Location**: `scripts/devShare.ts:56-72`
**First anchor line**: 56

**Claim**: The dev-share flow mints an owner API token and persists the plaintext bearer token to `.dev/agent.env`; the token is long-lived until explicit revocation, so a copied local file can authorize publishes as the owner.

**Evidence**: `scripts/devShare.ts:56-59` writes `PRESS_TOKEN` and `PRESS_URL` to `.dev/agent.env` with 0600; `:70-72` mints that token for `localnetUsers.owner`. `apps/web/src/auth/apiTokens.ts:26-37,75-82` returns plaintext and validates by hash, rejecting only revoked tokens; `schema.ts:96-108` has no expiry. `packages/cli/src/index.ts:155-156,406-417` uses `PRESS_TOKEN` to publish.

**Suggested fix**: Make dev-share token creation opt-in and short-lived/scoped; revoke the minted token on shutdown and delete `.dev/agent.env` during teardown. Prefer keychain or another secret-store handoff when an agent token must persist beyond one local session.

**Discovered by**: data-flow
**First seen**: uaudit-2026-07-03-ff6d8b · **Last verified**: uaudit-2026-07-03-ff6d8b

---

### F-11 (low) - Unpublished HTML is retained by moving the blob into `.archive` rather than deleting it...

**Fingerprint**: `b097a697d44113be2f0c383f8a21d33a389d1de3f1f38fa020b8b767d03c1f35`
**Status**: open
**Location**: `apps/web/src/publish/storage.ts:125-135`
**First anchor line**: 125

**Claim**: Unpublished HTML is retained by moving the blob into `.archive` rather than deleting it; archived report contents are no longer served but remain on disk and are included by storage-directory backups.

**Evidence**: storage.ts:16-22 builds paths under storageDir/.archive; storage.ts:130-135 renames the live blob there. routes.ts:753-758 calls archiveBlob then sets archivedAt. serving.ts:153-162 serves only rows with archivedAt null. docs/ops.md:75-76 rsyncs all of PRESS_STORAGE_DIR into backups.

**Suggested fix**: Document archive retention and add an operator purge path for confidentiality removals; exclude or separately encrypt .archive if archives must be retained.

**Discovered by**: data-flow
**First seen**: uaudit-2026-07-03-ff6d8b · **Last verified**: uaudit-2026-07-03-ff6d8b
