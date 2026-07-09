# press — DELTA

## 2026-07-09 — first-class page moves and permanent redirects

`press move <source> <destination> [--redirect permanent|none]` changes a
page's canonical `/p/` path without republishing it. The default permanent
redirect stores the old path as an alias to the stable page identity, so later
moves flatten every prior alias directly to the current canonical path rather
than building redirect chains. `--redirect none` leaves the immediate source at 404. Moving back consumes the page's own alias; unpublishing the target makes
all aliases return 404.

Moves are Bearer-only and owner-only. Cross-collection moves may create a new
owner collection or enter another collection owned by the same user, and they
materialize the source page's effective visibility so a different collection
default cannot widen or narrow access. Content bytes, title, password material,
allowlist, content hash, publisher, and original publication time are
preserved. Live destinations and other pages' redirect sources return 409;
archived destinations are reclaimable. Redirect lookup is public but returns no
report bytes; the destination still enforces the original ACL.

The additive migration creates `pageRedirect`, adds the `move` audit action,
and adds structured audit details for source, destination, and redirect mode.
The move holds source/destination advisory locks in canonical order, renames the
blob with fsync, and restores it if the database or audit transaction fails.
Publishing cannot shadow an active redirect source.

Harness evidence on the final pre-review state:

- Observed red: targeted unit imports failed for the absent redirect model,
  blob mover, response builder, and CLI parser; isolated localnet move tests
  failed with CLI exit 1 and API 404 before implementation.
- `nub run check`: pass (tsgo, oxlint, oxfmt; warning-only existing lint policy).
- `nub run test`: 193 pass, 1 platform skip, 0 fail.
- `nub run e2e`: 97/97 pass against a fresh migrated Postgres + production-built
  server, including ACL preservation, collision/ownership validation, archive
  reclamation, redirect lifecycle, and injected audit-failure blob rollback.
- `nub run walkthrough`: pass through real seeded-provider `press login`, CLI
  publish, permanent move/308, canonical read, list cleanup, no-redirect
  move/404, prior-alias retargeting, logout, and isolated teardown.

No production data, push, package/image publication, or deploy occurred.

## 2026-07-04 — blind-oracle judgment: web surface PASSES (incl. the F1/F5 gates)

Ran the `apps/web/BRIEF.md` § Oracle — the blind screenshot quorum — against a fresh
16-shot capture that now includes the F1 branded password-entry page and the F5 `/login`
identity gate (`bun scripts/capture-oracle-shots.ts`; `{feed, market-notes, login,
password-gate} × {light, dark} × {360, 1280}`). Three fresh-context, blind judge agents
(maker ≠ judge; each saw only the screenshots + Bar + Dimensions + exemplar names, never
the code/diff/repo) each rated every Dimension.

**Verdict: PASS.** All three judges rated all seven Dimensions `magazine-grade` (3/3 on
every Dimension — the ≥2/3 quorum is met with unanimity). Full dossier + verbatim verdicts
in `artifacts/oracle/JUDGMENT.md` (gitignored evidence). Representative evidence:

- Typographic hierarchy — "a large serif display head ('Reports for close reading.'), rust
  sans category labels, serif entry titles, and small sans bylines into one deliberate
  Stripe-Press-like system" (J1).
- Palette restraint — "near-monochrome cream/near-black base with a single restrained
  terracotta accent … confined to category labels" (J3).
- Responsiveness — "reflows cleanly from the 1280 two-column title/byline layout to a
  stacked single column at 360 … without overflow or crowding" (J3).
- Overall — "reads unmistakably as a modern editorial magazine in the Stripe Press mold,
  not an internal tool or dashboard" (J3); "a calm, typographic editorial magazine, not an
  internal tool" (J2).

**Watch-item (non-blocking, next-round input per Oracle step 3).** Judge 3 still rated
Accessibility `magazine-grade` but flagged that "the small terracotta labels on dark sit
near the lower edge of the range." Not a floor failure — the automated axe/contrast floor
passes in `nub run e2e` — but the dark-scheme category-label contrast margin is thin and
worth tightening if the palette is next revisited.

**Boundary.** This is the loop-side blind quorum. `apps/web/BRIEF.md` § Oracle "Final
acceptance" — Allen looking at the deployed instance and judging it reads like a
publication — is the human gate no quorum replaces, and remains outstanding.

## 2026-07-04 — dogfood bug bash fixes: password + identity-gate reader surfaces (F1–F5)

A Jefferson-persona dogfood/bug-bash of localnet surfaced five reader-facing gaps on the
password and identity-gate surfaces. All five are now fixed against newly-ratified contract
deltas (SPEC REQ-ACL-002, REQ-SRV-004, REQ-PUB-004/005, REQ-CLI-001/004, REQ-AUTH-008,
REQ-CFG-002; BRIEF + `apps/web/BRIEF.md` Decisions dated 2026-07-04).

**F1 — branded password entry page (REQ-SRV-004).** A browser reader of a `password` page now
gets a branded, self-contained editorial entry page (HTTP 200, no report body leak) instead of
the OS Basic-Auth dialog. `POST /p/:collection/:file` verifies the password, sets a short-lived
(1h), page-scoped, HttpOnly, SameSite=Lax, Secure-in-prod, HMAC-signed unlock cookie, then 303s
to the GET. The cookie feeds the same pure-ACL `basicPassword` channel — this is a read-side
unlock, not a mutation (INV-1 holds). Basic auth stays the programmatic-only channel
(`WWW-Authenticate: Basic` for non-HTML). The entry page carries a strict form-capable CSP
(`default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; …`) — the report sandbox
omits `allow-forms` and would block the unlock form — so it is the sole documented exception to
INV-2 / REQ-SRV-002; every other `/p/` response (including the unlock 303) still carries the
report sandbox CSP. Title/error are HTML-escaped. Malformed client cookies are ignored (boundary
validation) rather than 500ing and blocking a Basic fallback.

**F2 — reader guidance on publish (REQ-CLI-004).** `press publish` of a `password` page prints
the effective password once plus a guidance line pointing readers at the branded entry page.

**F3 — publisher-supplied custom page password (REQ-PUB-005, REQ-CLI-001).** A publisher may set
a custom page password (≥ 8 chars) via `--password` (value-less flag) → hidden TTY prompt /
`PRESS_PAGE_PASSWORD` / stdin, transported in the `X-Press-Page-Password` header — never argv,
never a query param, never logged (INV-4). Argon2-hashed, returned once. Weak (< 8) → 400.

**F4 — publish output honesty (REQ-PUB-004).** The publish response and CLI output echo the
resolved allowlist for `private` pages; `--json` carries `allow` and stays machine-clean.

**F5 — identity gate never a dead-end (REQ-AUTH-008, REQ-CFG-002).** `/login` always presents the
enabled provider's affordance, a reader-guidance line for someone who cannot sign in, and — on
localnet — a seeded-account hint (the literal F5 complaint: "what were the passwords?"). With no
provider it shows an explicit unavailable notice, not a copy-only dead-end. A pure
`loginAffordances()` decides the states (unit-tested incl. the never-dead-end invariant across all
provider combos). `loadServerConfig` now fails closed at boot when no provider is enabled
(REQ-CFG-002). Seeded creds flow only when credential auth is on (localnet); never shipped in
production, where credential auth is boot-refused (INV-5). The entry page and `/login` are added
to the blind screenshot oracle capture (`scripts/capture-oracle-shots.ts`).

**Harness discipline.** Pure, DB-free modules extracted for fast unit testing: page-password
cookie sign/verify + tolerant cookie parse, publish-response shape, CLI publish-output format,
page-password source resolution, login affordances. Every new REQ has a test observed red before
its fix. Web design floors extended: the branded entry page joins the no-horizontal-scroll matrix
at 360/768/1280/1920 (light + dark).

**Proofs.** `nub run check` + `nub run test` green (191 tests). `nub run e2e` green (94 passed,
0 residual) — full Playwright incl. the password-gate flow (branded gate → form unlock under CSP →
cookie read; Basic programmatic channel; wrong-password 401; unlock-303 sandbox CSP) and the
`/login` seeded-hint + guidance + design floors. `nub run walkthrough` green (real `press login`
as `owner@send.it` → publish → public 200 / private 401 → `press list`; 0 residual). Each F1–F5
milestone passed an independent Codex structured review (F1 through four fix cycles: guidance
reword, no error-swallow, CSP-contract reconciliation, malformed-cookie tolerance, unlock-303
headers). No push/deploy — Boundary is Allen's.

## 2026-07-04 — walkthrough proves the interactive setup path (credential provider, Google-OAuth seam)

`nub run walkthrough` (`scripts/agentWalkthrough.ts`) now performs a REAL `press login` instead of
minting a token, so it proves the interactive setup path end to end and exercises both plugin skills
against localnet.

**Auth-agnostic login.** The harness spawns `press login --no-open`, captures the loopback authorize
URL, and completes sign-in through a pluggable seam (`selectSignIn` / `SignInFactory`). On localnet
`credentialSignIn` drives the seeded credential provider — `POST /api/auth/sign-in/email` for
`localnetUsers.owner`, then a cookie-bearing GET of the authorize URL so the CLI's 127.0.0.1 callback
receives the code and stores a real token. A `googleOAuthSignIn` seam names the live path and refuses
to run on localnet (REQ-AUTH-002: never real Google in tests/loops). Switching identity providers when
press goes live is a one-strategy change; the loopback, code exchange, keychain, and publish path are
byte-for-byte identical.

**Hermetic keychain.** The macOS `security` keychain stub is extracted to
`scripts/pressCliKeychain.ts` (`writeKeychainStub`) and shared with `e2e/cli.spec.ts` (no behavior
change). A genuine `press login` round-trips a real token through a temp keychain
(`PRESS_E2E_KEYCHAIN_FILE`) without touching the operator's OS keychain or tripping a biometric; the
token never appears on argv. Teardown revokes it with `press logout` under the fail-closed cleanup.

**Both skills, executed.** press-setup: login → `press doctor --json` (`authenticated`, owner) →
`whoami --json`. press-publish: publish a public and a private report → read back HTTP 200 (public,
unauthenticated) / 401 (private, unauthenticated) → `press list` shows both.

**Proofs.** `nub run walkthrough` passed against the isolated `walkthrough` silo instance: logged in
as `owner@send.it`, doctor + whoami confirm, public 200 / private 401, list shows both, 0 residual
`press-walkthrough` containers. `nub run e2e` passed (82 passed, 0 residual) — the refactored
`e2e/cli.spec.ts` still green through the shared stub. `nub run check` and `nub run test` are green
(144 pass).

## 2026-07-04 — agent publish plugin + enforced minimal-auth footprint

press now ships an agent-facing publishing plugin and enforces an identity-only
Google auth footprint that stores no provider tokens.

**Minimal auth footprint (REQ-1).** `apps/web/src/auth/server.ts` enforces the
posture in two layers. A Better Auth `hooks.before` middleware
(`stripClientRequestedOAuthScopes`) removes client-supplied `scopes`/`scope` on
`/sign-in/social` and `/link-social`, and the Google provider is pinned to
identity-only scopes (`openid`, `email`, `profile`) with no offline access, so
the authorize URL is always identity-only. An `account` databaseHook
(`stripStoredProviderTokens`, wired on `databaseHooks.account.create.before` and
`update.before`) nulls `accessToken`, `refreshToken`, `idToken`, and their expiry
fields before any account row is written — closing Better Auth's ID-token
sign-in flow, which would otherwise persist client-supplied provider tokens. No
Google provider token reaches the database on any sign-in path; the columns
remain (no schema change) and are stored null via a supported hook, not an
adapter override. `apps/web/src/auth/server.test.ts` proves both layers: a
`drive.readonly` request still yields an identity-only authorize URL, and the
account create/update hooks null every provider token. F-04's provider-token
exposure is resolved (see `DEVIATIONS.md`, `AUDIT.md`); Better Auth session
bearer tokens remain the accepted residual, covered by the secret-bearing
backup runbook.

**CLI walkthrough support (REQ-3).** `packages/cli/src/index.ts` adds
`press doctor`: it reports the resolved host, token source (keychain / env /
none), the `whoami` identity when authenticated, and a next-step otherwise. The
authentication-required error names both paths — `press login` for interactive
use, `PRESS_TOKEN` + `PRESS_HOST` for agents. The `publish`/`list`/`whoami`/
`login` contracts are unchanged.

**Agent plugin (REQ-2).** `plugins/press/` is a cross-tool plugin with both
ingestion manifests (`.claude-plugin/plugin.json` for Claude Code,
`.codex-plugin/plugin.json` for Codex) sharing one `./skills` directory, plus
`CLAUDE.md`/`AGENTS.md` entry docs. Two skills drive the `press` CLI:
`press-setup` (acquire and verify a token — agent path via `nub run dev:share`
or a provided `PRESS_TOKEN`/`PRESS_HOST`, interactive via `press login`) and
`press-publish` (compose an HTML report, publish it, read it back, confirm the
ACL). `packages/cli/src/pressPlugin.test.ts` asserts both manifests are valid,
the Codex `interface` block is present, both skills exist, and every cited
`press` command is real.

**Executable proofs (REQ-4).** `nub run check` and `nub run test` are green
(`144 pass`, `0 fail`). The new `nub run walkthrough`
(`scripts/agentWalkthrough.ts`) boots an isolated `walkthrough` silo instance,
mints a seeded owner API token (no real Google), publishes a public and a
private report through the real `press` CLI, and verifies read-back plus ACL:
the public page returns HTTP 200 to an unauthenticated reader, the private page
returns HTTP 401, and `press list` shows both. The full Playwright suite passes
against the isolated `e2e` instance: `82 passed`. Both harnesses tear down
through env-scoped `docker compose down -v --remove-orphans` (captured
`COMPOSE_PROJECT_NAME` + absolute `COMPOSE_FILE`), leaving 0 residual containers.
Every milestone (auth footprint, `press doctor`, plugin, walkthrough) passed an
independent Codex structured review at its commit SHA.

## 2026-07-03 — phase 5 final verification

Sandbox-runnable verification is green on the final silo/Tilt localnet migration
state. `nub run check` exits 0: `tsgo -b`, `oxlint .`, and
`oxfmt --check .` pass, with oxlint reporting only the existing console and
await-in-loop warnings. `nub run test` exits 0 with `114 pass`, `0 fail`, and
`213 expect() calls` across 13 files.

The clean break holds. `scripts/localnet.ts` does not exist. The repository
search for `scripts/localnet\.ts|press-localnet|bootLocalnet|startLocalnet|withLocalnetDefaults|localnet:e2e`,
excluding `node_modules/`, `.rl/`, `.git/`, and `DELTA.md`, returns no matches.
The four silo lifecycle scripts (`scripts/e2e.ts`, `scripts/devShare.ts`,
`scripts/capture-oracle-shots.ts`, `scripts/backupRestoreDrill.ts`) tear down
through env-scoped `docker compose down -v --remove-orphans` using captured
`COMPOSE_PROJECT_NAME` plus absolute `COMPOSE_FILE`; none use a nameless
`silo down` teardown.

Driver-run executable proofs are green in the real Docker/Chromium environment.
The full Playwright e2e suite passes against the isolated `e2e` silo instance:
82 passed, exit 0, with 0 residual `press-e2e` containers after scoped
`docker compose down`. The isolation proof holds: a running `silo up main`
(`dev:share`) remains healthy during concurrent `nub run e2e`,
`press-main-postgres-1` survives, and the e2e run leaves 0 residual containers;
teardowns are scoped to each script's captured `COMPOSE_PROJECT_NAME` and
absolute `COMPOSE_FILE`, independent of lockfiles. The backup/restore drill
prints `PASS backup/restore drill`, proves `contentHash == blobHash`, ACL
`public=200` / `default-non-html=401`, DB-dump-first order, and 0 residual
containers. The `dev:share` smoke passes with seeded human sign-in plus
minted-token CLI publish; SIGINT cleanup runs scoped compose-down to completion
with 0 residual containers and `.dev/agent.env` removed.

## 2026-07-03 — silo/Tilt localnet clean break

The localnet migration is complete. `silo.toml`, `Tiltfile`, `tilt/**`, and
the parametrized `compose.yaml` now define the localnet, and every lifecycle
consumer boots through named silo instances: `main` for shared local dev,
`e2e` for Playwright, `drill` for backup/restore, and `oracle` for blind
screenshot capture. The old bespoke orchestrator is deleted; `nub run localnet`
now runs `TILT_EDITOR=true silo up main`, and `localnet:e2e` is gone because
`scripts/e2e.ts` owns isolated e2e bring-up.

The isolation guarantee is structural: each silo instance receives its own
generated `.silo.env`, ports, storage path, and compose project
(`press-main`, `press-e2e`, `press-drill`, `press-oracle`). That removes the
fixed-project collision class that previously let an e2e teardown destroy the
shared dev session's `press-localnet` Postgres container and volume.

Driver-side verification evidence for the migration:

- Phase 3: `nub run drill:backup-restore` printed `PASS backup/restore drill`
  with `contentHash == blobHash`, ACL `public=200` /
  `default-non-html=401`, DB-dump-first snapshot order, and 0 residual
  containers. `nub run dev:share` smoke passed with seeded human sign-in plus
  minted-token CLI publish; SIGINT cleanup ran `silo down --clean` to
  completion with 0 residual containers/volumes and `.dev/agent.env` removed.
- Phase 4 worker gate: `nub run check` passed after deleting the old
  orchestrator, rewiring scripts, and migrating oracle screenshot capture to
  the isolated `oracle` instance. Full Docker/Chromium executable proofs remain
  driver-run because the Codex sandbox cannot execute them; that limitation is
  recorded in `DEVIATIONS.md`.

Boundary handoff for Allen:

1. `nub run e2e` now requires `silo` + Tilt + Docker on the runner.
   `.github/workflows/ci.yml` installs them before the E2E step
   (`bun add -g @0xbigboss/silo@0.5.9`, pinned Tilt `v0.36.1`; ubuntu-latest
   ships Docker + the compose plugin system-wide). This could not be exercised
   from the local environment — confirm the first CI run converges (silo/Tilt
   PATH, Tilt convergence in Actions) at push time; the install step is the
   only unverified piece of the migration.
2. The review sandbox cannot run Docker/Chromium proofs; the unsandboxed driver
   is the execution gate for oracle screenshots, full e2e, and the isolation
   proof (all passed — see above).

## 2026-07-03 — v1.3 loop wrap (upstream, dev-share, hardening, v0.1.0)

The v1.3 loop is complete — all six phases done and independently reviewed.
Landed: upstream bump to `one@1.20.2` / `vite@8.1.3` with the three
workarounds evidence-kept and filed-ready drafts under `docs/upstream/`
(phase 0); `nub run dev:share` shared human+agent localnet with a minted
agent token and lifecycle-safe teardown (phase 1); a proven Better Auth
sign-in 429 floor (phase 2); a `nub run drill:backup-restore` durability
drill + `docs/ops.md` runbook (phase 3); a whole-repo security scrub —
8 findings fixed, 3 deferred to Allen (phase 4, `AUDIT.md` + `DEVIATIONS.md`);
and this feat-only history rebuild at `v0.1.0` (phase 5). Full harness was
green at wrap. Nothing was pushed. The v1.3 plan (`loop.md`, commit
`14a0268`) is absorbed into this file and deleted per its wrap prescription.

History rewrite (phase 5): local `main` was rebuilt from the 48-commit mixed
history into feat-only commits — `feat(core)`, `feat(cli)`, `feat(web)`,
`feat(harness)`, `feat(ci/image)`, one `docs` commit — plus
`chore(release): v0.1.0` and this wrap. The tree-identity gate held:
`git diff archive/pre-0.1.0 <feat-history>` was empty before the version
bumps. All four workspace packages are `0.1.0`. **Tag placement chosen:**
`v0.1.0` sits at the true launch tip (this wrap commit) so it carries no
`loop.md` and the final DELTA. `archive/pre-0.1.0` preserves the full
pre-rewrite history, so every historical SHA cited in this file
(`fe84121`, `ca8d601`, `14a0268`, etc.) remains reachable via that tag.

Boundary handoff for Allen (supersedes the v1.1-era list below):

1. Force-push the rewritten history and tags (private repo, Allen is the only
   consumer; `main` was pushed this morning as the old 48-commit history):
   - `git push --force-with-lease origin main`
   - `git push origin v0.1.0 archive/pre-0.1.0`
2. Confirm GitHub Actions is green on the rewritten `main`.
3. Repo hardening (GitHub settings): branch protection on `main`, secret
   scanning + push protection, Dependabot. The `update-deps` workflow now
   opens PRs (F-07), so branch protection composes cleanly.
4. Re-run the confirmatory security audit in a clean env/CI to flip the eight
   fixed findings to `resolved` (F-03/F-04/F-05 stay `open`, deferred) — the
   in-loop re-audit could not complete (see the re-audit entry below).
5. Decide the two deferred security findings (`DEVIATIONS.md`): F-03/F-05
   (CLI authorize approval screen, amends REQ-AUTH-004) and F-04 (token
   at-rest hashing/encryption, Better Auth framework-level).
6. Create the Google OAuth client.
7. Configure DNS for instance #1 at `reports.send.it`.
8. Build + mirror the image to `0xsend/press` with Allen's tag convention and
   author the manifests. Optional: trivy/scout scan the image first.
9. Provision ESO secrets.
10. Deploy.
11. Attended macOS keychain test (`press login` loopback on a real machine —
    stub-verified only in the loop).
12. Attended real-Google final-gate walkthrough required by `BRIEF.md`.

## 2026-07-03 — phase 4 security re-audit (bounded: could not complete)

The confirmatory re-audit meant to flip the eight fixed findings to
`resolved` in `AUDIT.md` could not complete cleanly in this environment; it
is bounded and documented here rather than left dangling.

- Attempt 1 (`uaudit-2026-07-03-0ae701`) failed at the amendment write:
  a hand-edit had set F-03/F-04/F-05 ledger `status` to `deferred`, which the
  amendment rejects (REQ-RL-UAUDIT-031 permits only `open|resolved`). Fixed by
  reverting those to `open` (commit `c580e82`); deferral context lives in
  `DEVIATIONS.md`, not the ledger enum.
- Attempt 2 (`uaudit-2026-07-03-222408`) hung in discovery
  (`partial_batch: true`, `failed_personas: [data-flow]`) and was killed. The
  killed coordinator wrote an INVALID partial amendment marking all 11
  findings `resolved` — including the deferred, unfixed F-03/F-04/F-05. That
  false-`resolved` amendment was discarded (`git checkout AUDIT.md`); the
  committed ledger stays all-`open` (the fail-safe direction — it never
  overstates a fix).

Verification the fixes stand on WITHOUT the re-audit: 16 new regression tests
(`nub run test` 114 pass, was 98), `nub run e2e` 81/81, driver live dev:share
lifecycle checks, and an independent `rl review` structured APPROVE on the
full phase-4 range (validated each fix against its finding). The re-audit is
confirmatory (personas don't re-find the vulns), not the sole verifier.

Handoff: re-run `rl ultra-audit start --scope-paths "**" --profile security`
in a cleaner environment (or CI) to authoritatively flip F-01/02/06/07/08/09/
10/11 to `resolved`; F-03/F-04/F-05 will correctly remain `open` (deferred).

## 2026-07-03 — phase 4 security scrub fixes

Seven non-deferred findings from `uaudit-2026-07-03-ff6d8b` are fixed in this
packet. F-01 rejects CLI authorization while a Better Auth admin impersonation
session is active, with a regression asserting no verification row is created.
F-02 makes bearer-token verification fail closed for actively banned users while
still accepting expired bans, and records `lastUsedAt` only after success.
F-06 adds a CLI loopback `state` nonce end to end; mismatched callbacks now get
HTTP 400 and the listener stays alive for the real callback.

F-07 rewrites the scheduled dependency updater to use pinned actions, least
privilege permissions, and a pull request instead of pushing to `main`. F-08
adds SHA-256 migration checksums with fail-closed drift detection and preserves
legacy null-checksum rows as un-verifiable. F-09 pins the non-flake
`shell.nix` flake-compat fallback to the `flake.lock` revision. F-10 revokes
the dev-share minted agent token and deletes `.dev/agent.env` during signal
teardown. F-11 documents that unpublish archives remain under
`PRESS_STORAGE_DIR/.archive`, are included in storage backups, and require a
separate irreversible purge for confidentiality removals.

Tests added: `apps/web/src/auth/cliFlow.test.ts`,
`apps/web/src/auth/apiTokens.test.ts`, `apps/web/src/db/migrate.test.ts`, and
`packages/cli/src/index.test.ts`. F-03, F-04, and F-05 remain deferred to Allen
per `DEVIATIONS.md`; `AUDIT.md` is left for the driver audit amendment.

F-10 follow-up: `dev:share` now keeps `.dev/agent.env` present for the whole
running session. The localnet shutdown hook awaits agent-token revocation and
then deletes the env file before the server stop and process exit proceed.
The server child error/exit path also runs that shutdown hook before teardown.

Driver live-verification evidence, 2026-07-03 (the first F-10 attempt had a
timing bug the driver caught — the `finally` cleanup fired at boot because
`startLocalnet` resolves post-boot; the `onShutdown` hook fixes it):

- While running: `.dev/agent.env` present; `GET /api/cli/whoami` with the
  minted token returned `200`; `nub run dev:share:smoke` passed
  (`press dev:share smoke passed`).
- After SIGINT: `.dev/agent.env` DELETED; no `devShare` process and no
  `press` containers remained (clean teardown).
- Token revocation is ordered before exit by the awaited `onShutdown` hook;
  it cannot be probed post-shutdown because the DB is torn down, so the
  ordering is code-verified and confirmed in review.
- `nub run e2e` after the `localnet.ts` `onShutdown` change: 81 passed.

## 2026-07-03 — phase 3 backup/restore drill

`nub run drill:backup-restore` now proves the durability procedure end to end:
seeded localnet boot, baseline DB row/contentHash capture, blob byte hash,
public/default ACL probe pair, Postgres custom-format dump, blob snapshot,
full compose volume and storage destruction, restore into fresh Postgres
without re-seeding, blob restore, server boot, and repeated verification.

The prescribed snapshot order is database first, blob directory second. Rows
are the source of truth for existence and ACL; a row without a blob is a
serving failure, while a blob without a row is a harmless orphan. The runbook
requires maintenance/read-only mode for publish/delete traffic during the
snapshot, then uses DB-first order so any blob copied after the dump cannot
create a served page without a row.

In-sandbox evidence, exit status 0:

```text
PASS backup/restore drill
page: market-notes/agent-margin-review.html
contentHash: 65da66d643ca6d410a60fb75239633eafd5f75620b2fac91db5bb664db670c67
blobSha256: 65da66d643ca6d410a60fb75239633eafd5f75620b2fac91db5bb664db670c67
acl: public=200 default-non-html=401
snapshotOrder: database dump first, blob snapshot second
```

Driver evidence, recorded 2026-07-03: independent rerun of
`nub run drill:backup-restore` from the driver environment — exit 0,
`PASS backup/restore drill`, isolated compose project torn down cleanly
(containers, volume, network removed).

## 2026-07-03 — phase 2 rate-limit evidence

The Better Auth credential sign-in rate-limit floor is now verified without
lowering the shared Playwright webServer cap. The sign-in custom rule reads
`PRESS_RATE_LIMIT_SIGNIN_MAX` and `PRESS_RATE_LIMIT_SIGNIN_WINDOW`, with the
ratified defaults preserved when unset: production remains max 5 / 60s, and
non-production remains max 10,000 / 60s. The global limiter defaults remain
unchanged at production max 100 / 60s and non-production max 10,000 / 60s.
Malformed override values fail boot loudly with the offending variable name.

`e2e/rateLimit.spec.ts` starts its own short-lived `one serve` process on a
distinct port, points `PRESS_BASE_URL` at that instance, sets the strict
sign-in cap only in that child process, shares the already-booted localnet
Postgres and built web artifact, then tears the child down in `finally`. This
keeps the low cap out of Playwright's shared server and avoids leaking rate
limit state into unrelated specs that share one client IP.

In-sandbox curl dry-run evidence (Chromium was not launched): with shared
localnet Postgres booted by `nub run localnet:e2e`, a strict isolated server on
`http://127.0.0.1:4180` was started with
`PRESS_RATE_LIMIT_SIGNIN_MAX=3` and `PRESS_RATE_LIMIT_SIGNIN_WINDOW=2`. Six
sequential `curl` POSTs to `/api/auth/sign-in/email` observed:
`401, 401, 401, 429, 429, 200`. The fourth wrong-password request returned
`429` with `x-retry-after: 2`; the immediate correct-password request also
returned `429` with `x-retry-after: 2`; after the 2s window elapsed, the
correct-password request returned `200`.

## 2026-07-03 — phase 1 dev share

`nub run dev:share` now wraps the existing localnet boot path, prints a shared
human+agent who's-who card after the ready line, mints a fresh owner API token
into `.dev/agent.env` without echoing it, and keeps the same SIGINT teardown.
The verifier is `nub run dev:share:smoke` against the running shared session:
it proves credential sign-in over HTTP, then publishes through the real CLI
using the generated agent env and checks the served page.

## 2026-07-03 — phase 0 upstream reconcile

Status: complete for the local sandbox interior. Dependencies are bumped from
`one@1.19.4` / `vite@8.0.3` to `one@1.20.2` / `vite@8.1.3`. `one@1.20.2`
declares `vite` as dependency range `^8.0.13`, so `vite@8.1.3` is inside
One's supported range and was kept. `nub install` initially failed because
the sandbox could not write user-level nub/npm caches; rerunning with
`XDG_CACHE_HOME`, `XDG_DATA_HOME`, and `npm_config_cache` under
`/private/tmp` regenerated `lock.yaml`.

Experiment matrix:

- Bumped deps + transform removed:
  - Edit: unregistered `tamaguiUseEventReactImportPlugin()` from
    `apps/web/vite.config.ts`.
  - Command: `nub run build:web`
  - Exit status: 1.
  - Failure output, verbatim:

```text
apps/web build: Error importing page (original error) ReferenceError: React$15 is not defined
apps/web build:     at file:///Users/allen/0xbigboss/press/apps/web/dist/server/_virtual_one-entry.js:7660:2
apps/web build:  ERROR  Error importing page: dist/server/assets/_collection__ssr-DogSemhY.js
apps/web build:   [cause]: React$15 is not defined
apps/web build:       at dist/server/_virtual_one-entry.js:7660:2
apps/web build: exit 1
```

- Dist evidence: `apps/web/dist/server/_virtual_one-entry.js:7660`
  contained `React$15.useInsertionEffect || React$15.useLayoutEffect;`.
- Outcome: transform still required; workaround kept.

- Bumped deps + transform kept:
  - Command: `nub run build:web`
  - Exit status: 0.
  - Evidence: production build completed, secret scan passed, and One printed
    `build complete` / `Done`.
  - Outcome: dependency bump itself is green when the transform is retained.

- Bumped deps + `/api/collections` delegation reverted:
  - Edit: removed the bare-path check before `parseCollectionPath()`.
  - Command: `nub run check`
  - Exit status: 0.
  - Evidence: `tsgo -b`, `oxlint .`, and `oxfmt --check .` completed; only
    pre-existing lint warnings were reported.
  - Command: `nub run test`
  - Exit status: 0.
  - Evidence: `98 pass`, `0 fail`, `169 expect() calls`.
  - Server command: `nub run localnet:e2e`
  - Server status: reached `press localnet prod server ready at
http://127.0.0.1:4174`; stopped with Ctrl-C after probes, exit status 0.
  - Probe command: `curl -i --max-time 10 http://127.0.0.1:4174/api/collections`
  - Curl exit status: 0; semantic result failed the expected 401 floor.
  - Failure output, verbatim:

```text
HTTP/1.1 400 Bad Request
cache-control: no-cache
content-type: application/json
content-length: 65
Date: Fri, 03 Jul 2026 14:35:23 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"error":"collection slug: must match ^[a-z0-9][a-z0-9-]{0,62}$"}
```

- Probe command: `curl -i --max-time 10 http://127.0.0.1:4174/api/collections/`
- Curl exit status: 0; semantic result also failed the expected 401 floor.
- Failure output, verbatim:

```text
HTTP/1.1 400 Bad Request
cache-control: no-cache
content-type: application/json
content-length: 65
Date: Fri, 03 Jul 2026 14:35:23 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"error":"collection slug: must match ^[a-z0-9][a-z0-9-]{0,62}$"}
```

- Health probe: `curl -i --max-time 10 http://127.0.0.1:4174/healthz`
  returned `HTTP/1.1 200 OK` with body `ok`, proving the server was live.
- Outcome: bare-path delegation still required; workaround kept.

Final adopted state: bumped dependencies are kept; the
`press:tamagui-use-event-react-import` transform is kept; the bare
`/api/collections` delegation is kept; the bounded 413 body drain remains
kept by design. Filed-ready upstream drafts were added at
`docs/upstream/rolldown-namespace-binding.md`,
`docs/upstream/one-serve-api-collections.md`, and
`docs/upstream/one-serve-413-reset.md`. Full Playwright e2e remains a driver
handoff because Chromium does not launch in this sandbox.

Driver evidence, recorded 2026-07-03, on the adopted state (one@1.20.2,
vite@8.1.3, all three workarounds retained):

- `nub run e2e`: exit 0, 80 passed (22.4s).
- `nub run smoke:image`: exit 0, `press image smoke passed for
press-web:local` (boot refusal, seeded feed, and exact sandbox CSP proven
  from inside the container).

With the worker's in-sandbox `check`, `test`, and `build:web` greens, the
full harness is green in the final adopted state; phase-0 acceptance holds.

## 2026-07-03 — Allen ratifications (visibility default, link affordance)

Both open ratifications are resolved by Allen, attended:

- `password` as a collection `defaultVisibility` is **rejected, ratified**.
  SPEC.md now types `Collection.defaultVisibility` as
  `'default' | 'public' | 'private'` and REQ-PUB-006 states the 400 contract;
  the root `BRIEF.md` visibility Decision records it. Code and tests already
  enforced this (`packages/core/src/index.ts:9`, `e2e/publish.spec.ts:339`).
- Judge G's round-3 dissent on entry-title static link affordance is
  **resolved: hover-only stands** (magazine convention). Recorded as a
  ratified Decision in `apps/web/BRIEF.md`; no code change.

With these, no pending ratifications remain. Everything left is the Boundary
handoff list below (push onward).

## 2026-07-03 — v1.2 loop wrap (CI completeness, keep-alive evidence)

Status: the v1.2 loop is complete — both phases done and independently
reviewed. CI now defines the full harness (check, test, e2e, build:web,
smoke:image; verify-only, executes after Allen's push), and the last e2e
harness divergence from real clients — the `Connection: close` API-context
mitigation — is deleted on recorded keep-alive evidence. No deviations
remain active in `DEVIATIONS.md`. The v1.2 plan (`loop.md`, commit
`ca8d601`) was absorbed and deleted per its wrap prescription. The Boundary
handoff list below is unchanged and remains Allen's.

## 2026-07-03 — v1.2 phase 0 CI gate completeness

CI now runs the full local harness in order: `nub run check`, `nub run test`,
`nub run e2e`, `nub run build:web`, and `nub run smoke:image`, with bounded
job and step timeouts. It remains verify-only and still executes only after
Allen pushes the repo.

## 2026-07-03 — v1.2 phase 1 Connection close evidence

The e2e API-context `Connection: close` mitigation was removed from
`e2e/api.ts`, so Playwright API contexts now use default keep-alive behavior
against `one serve`. Assertions and other harness behavior are unchanged. This
is pending the driver's evidence series: at least 3 consecutive cold-state full
`nub run e2e` runs after the mitigation removal.

Driver evidence, recorded 2026-07-03 (state forced maximally cold before run
1: `docker compose -p press-localnet down -v` plus storage removal):

- Run 1: `nub run e2e` exit 0, 80 passed (22.3s).
- Run 2: `nub run e2e` exit 0, 80 passed (20.7s).
- Run 3: `nub run e2e` exit 0, 80 passed (20.8s).

No `EPIPE`/`ECONNRESET` or any API-write failure appeared; the mitigation is
deleted for good and `DEVIATIONS.md` reflects the outcome.

## 2026-07-03 — v1.1 loop wrap (production build, prod serving, image)

Status: the v1.1 loop is complete — all 4 phases done and independently
reviewed. `nub run build:web` produces a production-mode One build (the
upstream `React$<N>` Rolldown deconfliction bug is neutralized by an
app-level transform); e2e runs the built artifact via `one serve` and the
cold-start reproducibility deviation is retired on 3x consecutive
maximally-cold 80/80 runs; `press-web:local` builds locally and
`nub run smoke:image` proves boot refusal, the seeded feed, and the exact
sandbox CSP from inside the container. Full harness at wrap:
`nub run check` + `test` (98) + `e2e` (80/80) + `build:web` + `smoke:image`
all green. Nothing pushed; the working tree is committed on local `main`.
The v1.1 loop plan (`loop.md`, commit `fe84121`) was absorbed into this file,
`DEVIATIONS.md`, and `SPEC.md`, then deleted per its own wrap prescription.

Surviving law from the absorbed plan: the build-fix intervention ladder
(app config → committed patch → dependency version change, forking One out
of scope) governs any future regression of the upstream bug; deviation
retirement always requires recorded evidence, never assertion.

## 2026-07-03 — v1 loop wrap

Status: all 8 loop phases are complete. The full harness is green from a clean
localnet boot, and the magazine screenshot oracle reached quorum in round 3
(2-of-3 judges passed). Judge G's dissent on static link affordance for entry
titles remains a taste follow-up for Allen.

Known gaps and follow-ups:

- One production build is green as of phase-1. The chosen intervention is
  app-level config: `apps/web/vite.config.ts` adds a focused pre-transform for
  `@tamagui/use-event/dist/esm/useGet.mjs` that rewrites the React namespace
  import to named hook imports before One's production SSR bundle reaches the
  Vite 8 / Rolldown deconfliction bug. `apps/web/src/buildWeb.ts` wraps
  `one build --platform=web` with deterministic local build-time env in
  production mode so One's prerender import can evaluate server config without
  live OAuth or secrets; runtime boot validation remains unchanged.
- Attempt-1 review reject: the first green `nub run build:web` was not valid
  production evidence because `apps/web/src/buildWeb.ts` defaulted
  `NODE_ENV=development` and enabled credential auth, producing React
  development artifacts. Production-mode repros then proved INV-5 was still
  intact: `NODE_ENV=production nub run build:web` refused credential auth, and
  `NODE_ENV=production PRESS_ENABLE_CREDENTIAL_AUTH=0 nub run build:web`
  refused missing Google OAuth client values during One's prerender-time
  config import. The wrapper now defaults `NODE_ENV=production`,
  `PRESS_ENABLE_CREDENTIAL_AUTH=0`, and uses clearly labeled
  `build-placeholder` OAuth values plus a build-only Better Auth placeholder.
  These placeholders are not secrets and exist only so the build machine can
  pass production config parsing; runtime production boot validation is
  unchanged and still refuses bad env at serve time.
- Rejected config probes before the final app-level transform: adding
  `@tamagui/use-event` to `ssr.external` bypassed the missing `React$15`
  binding but failed prerender with
  `SyntaxError: Export '_disableMediaTouch' is not defined in module`;
  `resolve.dedupe: ['react', 'react-dom']` had no effect and returned the same
  `ReferenceError: React$15 is not defined`; removing app-level
  `ssr.noExternal` also returned the same `React$15` failure. A direct
  installed-package rewrite of `@tamagui/use-event` proved the named-import
  change moved the build past the Rolldown failure, but a committed package
  patch was rejected because `nub patch` could not locate the app-local package
  in the current hoisted install layout and manual `patchedDependencies`
  metadata did not apply on `nub install`.
- Root cause, production build failure: the 2026-07-03 `nub run build:web`
  repro emits the missing read in `apps/web/dist/server/_virtual_one-entry.js`
  at `7660:2`, inside the `@tamagui/use-event/dist/esm/useGet.mjs` region
  (`apps/web/dist/server/_virtual_one-entry.js:7657-7661`). The route import
  that triggers evaluation is `/app/c/[collection]+ssr.tsx` to
  `./assets/_collection__ssr-DogSemhY.js`
  (`apps/web/dist/server/_virtual_one-entry.js:31643`), and that page chunk
  imports `useLoader` from `../_virtual_one-entry.js`
  (`apps/web/dist/server/assets/_collection__ssr-DogSemhY.js:1`).
  `apps/web/dist/server/assets/react-dom-B39j4I0W.js:9-15` is the shared
  `__esmMin` wrapper that rethrows the failed initializer; its React export is
  `require_react`, not a `React$15` binding
  (`apps/web/dist/server/assets/react-dom-B39j4I0W.js:405-406`,
  `apps/web/dist/server/assets/react-dom-B39j4I0W.js:564`).
- The `React$15` binding was supposed to be the namespace import for
  `import * as React from "react"` in `@tamagui/use-event`:
  the package source reads `React.useInsertionEffect || React.useLayoutEffect`
  (`apps/web/node_modules/@tamagui/use-event/dist/esm/useGet.mjs:1-2`), and
  Vite's SSR dependency prebundle lowers that source to an explicit
  `import_react` declaration plus `__toESM(require_react(), 1)`
  (`apps/web/node_modules/.vite/deps_ssr/@tamagui_use-event.js:11-15`).
  The final production SSR chunk keeps the deconflicted read as
  `React$15.useInsertionEffect || React$15.useLayoutEffect` but does not emit
  the matching declaration in the surrounding initializer
  (`apps/web/dist/server/_virtual_one-entry.js:7657-7666`); the neighboring
  React namespace imports are emitted as `import_react$117` before it and
  `import_react$116` after it
  (`apps/web/dist/server/_virtual_one-entry.js:7599-7603`,
  `apps/web/dist/server/_virtual_one-entry.js:8333-8336`).
- Ownership evidence points to the Vite 8 / Rolldown production SSR bundling
  step as exercised by One, not to app route code. One creates the virtual
  entry with `import.meta.glob(...)` routes and no React namespace binding
  (`apps/web/node_modules/one/dist/esm/vite/plugins/virtualEntryPlugin.mjs:96-121`),
  then imports each built server route during prerender
  (`apps/web/node_modules/one/dist/esm/cli/build.mjs:729-737`). The app config
  only wires Tamagui, One, aliases, and `ssr.noExternal: true`
  (`apps/web/vite.config.ts:1-35`). Tamagui's Vite transform is scoped to
  `.tsx` files (`apps/web/node_modules/@tamagui/vite-plugin/dist/esm/plugin.mjs:286-300`),
  while the failed source is `.mjs`
  (`apps/web/node_modules/@tamagui/use-event/dist/esm/useGet.mjs:1-2`).
  One's server build runs through Vite with `build.ssr: true`,
  `rolldownOptions`, and strict entry signatures
  (`apps/web/node_modules/one/dist/esm/cli/build.mjs:403-428`), so the dropped
  declaration is in Rollup/Rolldown namespace-import deconfliction/interop for
  the SSR chunk produced under One's build pipeline.
- Phase-1 fix directions, ranked by the allowed intervention order in the
  loop plan (`loop.md@fe84121:41-46`, `loop.md@fe84121:75-87` (absorbed plan, in git history)): first try app-level Vite/One
  config because the app already controls `ssr.external`, `ssr.noExternal`,
  aliases, and plugin order (`apps/web/vite.config.ts:7-35`), and the
  supporting evidence is that prebundled SSR output preserves the binding
  (`apps/web/node_modules/.vite/deps_ssr/@tamagui_use-event.js:11-15`) while
  the production final chunk does not
  (`apps/web/dist/server/_virtual_one-entry.js:7657-7666`). If config cannot
  force a correct SSR boundary, use a committed `bun patch` against One/Vite
  integration because One owns the production prerender import and SSR build
  configuration (`apps/web/node_modules/one/dist/esm/cli/build.mjs:403-428`,
  `apps/web/node_modules/one/dist/esm/cli/build.mjs:729-737`). Treat a One
  version change as third because the installed versions are pinned in
  `apps/web/package.json:21-27`, and the loop plan allows version changes only
  after config and patch paths (`loop.md@fe84121:41-46`, absorbed plan).
- The `build:web` gate is green after phase-1 in production mode:
  `nub run build:web` completes `one build --platform=web`,
  imports/prerenders `/`, `/login`, and `/c/:collection`, emits
  `version.json`, passes One's client bundle security scan, and the wrapper's
  fail-closed scan finds no `*.development.js` artifacts in `apps/web/dist/`.
- Phase-2 production-representative serving is wired for e2e. `nub run localnet`
  still starts the One dev server for interactive development.
  `nub run localnet:e2e` builds `@press/core`, builds `@press/web` with the
  phase-1 production-mode `build:web` wrapper, then boots localnet Postgres,
  migrates, seeds, and starts
  `one serve --host 127.0.0.1 --port ${PRESS_PORT:-4174}` under the same
  non-production localnet runtime env (`NODE_ENV=development`,
  `PRESS_ENABLE_CREDENTIAL_AUTH=1`). Playwright's `webServer` now uses
  `nub run localnet:e2e`.
- One 1.19.4 serve contract checked locally: the CLI exposes `one serve`
  (`apps/web/node_modules/one/dist/esm/cli.mjs`), accepts `--host`, `--port`,
  and `--outDir`, and serves `dist/buildInfo.json` through
  `apps/web/node_modules/one/dist/esm/serve.mjs`. It only calls
  `loadEnv("production")` when `--loadEnv` is passed, so e2e can serve the
  built output without switching runtime config to production or weakening
  INV-5 / REQ-CFG-001.
- Phase-2 in-sandbox serving proof (Chromium not launched in this sandbox):
  `nub run localnet:e2e` completed the production web build, migrated and
  seeded Postgres, and reported
  `press localnet prod server ready at http://127.0.0.1:4174`. HTTP probes
  against that server returned:
  `curl -i /healthz` -> `HTTP/1.1 200 OK` with body `ok`;
  `curl -i /` -> `HTTP/1.1 200 OK` and the SSR feed shell contained
  `press-shell`, `Reports for close reading.`, and `Agent Margin Review`;
  `curl -i /login` -> `HTTP/1.1 200 OK` and the SSR login shell contained
  `Sign in to keep reading.`, `Email`, and `Password`;
  `curl -i /p/market-notes/agent-margin-review.html` ->
  `HTTP/1.1 200 OK`,
  `content-security-policy: sandbox allow-scripts allow-popups`,
  `x-content-type-options: nosniff`, `referrer-policy: no-referrer`,
  `cache-control: no-store`, and body title `Agent Margin Review`.
- Attempt-2 prod-server repro proof against the same booted `one serve`
  localnet: `curl -i /api/collections` without a bearer token returned
  `HTTP/1.1 401 Unauthorized` with `{"error":"valid bearer token required"}`,
  not the catch-all slug-parse 400. An authenticated curl using a freshly
  minted localnet API token passed via curl stdin config returned
  `HTTP/1.1 200 OK` from `GET /api/collections` with the seeded collections
  `market-notes`, `systems-review`, `field-library`, and `private-docket`.
  A curl `PUT /api/pages/<proof-collection>/too-large.html` with
  `Content-Type: text/html` and a `PRESS_MAX_UPLOAD_BYTES + 1` byte temp file
  returned a readable `HTTP/1.1 413 Payload Too Large` response body:
  `{"error":"request body exceeds PRESS_MAX_UPLOAD_BYTES"}`. No client-side
  `ECONNRESET` occurred.
- The e2e `Connection: close` API-context mitigation is retained. The sandbox
  proof used HTTP curl only, not Playwright API contexts, so there is no
  evidence that the mitigation is unnecessary under `one serve`; assertions
  remain unchanged.
- Attempt-3 trace evidence: the failing `magazine.spec.ts` trace shows the
  authenticated `/c/market-notes` document returned `200 OK` and rendered the
  expected three-title collection before `allTextContents()` raced a same-path
  client document navigation, with no content-changing ACL result observed.
- Cold-start flake deviation: driver evidence recorded 2026-07-03. State was
  forced maximally cold before run 1 (`docker compose -p press-localnet down
-v` plus storage dir removal, immediately after new code landed); each run
  boots localnet from scratch and tears it down, so all three runs are cold.
  - Run 1: `nub run e2e` exit 0, 80 passed (22.0s).
  - Run 2: `nub run e2e` exit 0, 80 passed (21.6s).
  - Run 3: `nub run e2e` exit 0, 80 passed (20.8s).
    An earlier attempt-2 series (80/80, 80/80, 79/80) exposed the
    `magazine.spec.ts` snapshot-read race that attempt 3 fixed; the deviation
    is retired in `DEVIATIONS.md` on this evidence.
- Phase-3 local image is wired and smoke-gated. `Dockerfile` builds
  `press-web:local` with Node 24 plus Bun 1.3.13 and Nub 0.2.5, installs from
  the committed `lock.yaml` with `--frozen-lockfile`, builds `@press/core`,
  runs the production `apps/web/src/buildWeb.ts` wrapper, and serves the built
  artifact with `one serve --host 0.0.0.0 --port ${PRESS_PORT:-4174}` after a
  fail-loud config preflight (`apps/web/src/setupServer.ts`). The image embeds
  no real secrets; build-time placeholders remain the same non-secret phase-1
  values, and runtime config is supplied by `docker run` env/env-file.
- `nub run smoke:image` is the local image gate. It uses a deterministic local
  tag (`press-web:local`, overrideable via `PRESS_IMAGE_NAME`), builds with
  `docker buildx build --load`, proves missing-env boot refusal and the
  `NODE_ENV=production` + `PRESS_ENABLE_CREDENTIAL_AUTH=1` INV-5 refusal,
  boots localnet Postgres through `compose.yaml`, runs the same migrate/seed
  commands as `scripts/localnet.ts`, starts the container on the compose
  network with seeded localnet env, then HTTP-checks `/healthz`, `/`, and the
  seeded public page
  `/p/market-notes/agent-margin-review.html`. The page check byte-compares the
  observed `content-security-policy` header against the canonical
  `servedPageHeaders['Content-Security-Policy']` constant. The script removes
  the app container, compose network, and volumes in `finally`.
- Handoff for the `0xsend/press` mirror: Allen should choose the remote image
  repository/tag convention, rebuild from this Dockerfile, run
  `nub run smoke:image` locally against that tree, then push/mirror the image
  and author manifests outside this loop. No registry login, remote tag, push,
  deploy manifest, DNS, or live secret was created here.
- Real macOS keychain interaction is stub-verified only and remains an attended
  final gate.
- GitHub Actions has not executed because the repo has not been pushed.

Boundary handoff for Allen:

1. Push the repo to `unrulysystems/press`.
2. Confirm GitHub Actions is green.
3. Create the Google OAuth client.
4. Configure DNS for instance #1 at `reports.send.it`.
5. Build and mirror the image to `0xsend/press` with Allen's remote tag
   convention, then author the manifests.
6. Provision ESO secrets.
7. Deploy.
8. Run the attended real-Google final-gate walkthrough required by `BRIEF.md`.

## 2026-07-02 — password as collection defaultVisibility rejected

Ratified by Allen 2026-07-03 (see entry above): `password` is rejected as a collection
`defaultVisibility`. The SPEC Domain model types the four-value visibility union
on `Page.visibility`; `Collection.defaultVisibility` is not explicitly typed.
Password visibility requires per-page server-generated material: the one-time
password response and stored argon2 hash from REQ-PUB-005. Collection-level
inheritance cannot supply that material, including retroactively when patching a
collection default would flip existing unset pages into password-with-no-hash.
The coherent fail-closed reading is that collection defaults range over
`default | public | private`, while `password` is page-explicit only.
