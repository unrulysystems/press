## 2026-07-06 — Google sign-in button: POST fix + click-path harness gap

Production login was fully broken. `apps/web/app/login+ssr.tsx` rendered the
"Continue with Google" affordance as a GET `<a href="/api/auth/sign-in/social?…">`,
but Better Auth's `/sign-in/social` is POST-only (a GET 404s). Because production
refuses credential auth (INV-5), Google is the only provider — so every sign-in
attempt 404'd. Fixed by making the affordance a `<button>` that POSTs
`{provider, callbackURL}` and redirects to the returned `{url}` (mirrors the
credential-form fetch pattern, which e2e already covers).

**Harness gap (accepted):** the Google click-path is not e2e-covered. Localnet is
credential-only (REQ-AUTH-002 / the never-real-Google rule), there is no React
render-test infra, and Playwright cannot re-env the running dev server per test to
enable the Google provider — so the button's POST→redirect cannot be exercised in
the existing harness without disproportionate new infrastructure. Verification for
this fix rests instead on: static `nub run check`; a live-endpoint probe against
production (`POST /api/auth/sign-in/social` → 200 `{redirect, url:accounts.google.com}`,
`GET` → 404); and the manual OAuth click-through, which is the Boundary gate for
Google sign-in regardless. The stale `e2e/auth.spec.ts` assertion was moved from the
`link` role to the `button` role to match the fix.

## 2026-07-04 — F-04: Google provider tokens are never persisted; residual session-token exposure accepted

The provider-token half of F-04 (whole-repo security ultra-audit) is eliminated,
not merely mitigated: press stores no Google `accessToken`, `refreshToken`, or
`idToken` at rest. press uses Google OAuth only to establish identity at sign-in
and reads none of these tokens afterward.

**Decision:** press enforces the minimal Google auth footprint in two layers.

1. _Request enforcement._ The Better Auth `hooks.before` middleware
   (`stripClientRequestedOAuthScopes` in `apps/web/src/auth/server.ts`) removes
   client-supplied `scopes` / `scope` from `/sign-in/social` and `/link-social`
   before Better Auth builds the Google authorize URL, and the provider is pinned
   to identity-only scopes (`openid`, `email`, `profile`) with no offline access
   or consent prompt. So Google is only ever asked for identity and issues no
   refresh token. This is verified by `apps/web/src/auth/server.test.ts`
   (a `drive.readonly` request still yields an identity-only authorize URL).

2. _Storage enforcement._ An `account` databaseHook
   (`stripStoredProviderTokens`, wired on `databaseHooks.account.create.before`
   and `update.before`) nulls `accessToken`, `refreshToken`, `idToken`,
   `accessTokenExpiresAt`, and `refreshTokenExpiresAt` before any account row is
   written. This closes Better Auth's ID-token sign-in flow, which would
   otherwise persist client-supplied `idToken.accessToken` / `refreshToken` that
   are not bound to the enforced authorize scopes. No provider token reaches the
   database on any sign-in path; the columns remain (no schema change) and are
   stored null. Verified by `server.test.ts` (the create + update hooks null all
   provider tokens).

**Residual (accepted):** Better Auth session bearer tokens remain at the
framework default (unhashed at rest). The phase-3 backup runbook already treats
the DB and all dumps as secret-bearing, which covers this residual.

**Rejected alternatives:** hashing Better Auth session tokens and dropping the
`account` token columns were both declined — each overrides Better Auth's
adapter/storage schema, which fights the framework for marginal benefit.
Nulling via the supported `databaseHook` achieves "store no provider auth
material" without an adapter override or a schema change.

## 2026-07-03 — silo/Tilt migration: sandbox cannot run executable proofs (driver is the execution gate)

The silo + Tilt localnet migration (`silo.toml`, `Tiltfile`, `tilt/**`,
`scripts/e2e.ts`, `scripts/devShare.ts`, `scripts/backupRestoreDrill.ts`,
`scripts/capture-oracle-shots.ts`) depends on Docker and Chromium at verification
time. The Codex worker/reviewer sandbox cannot execute either, so their in-sandbox
failure is a documented environment limitation, **not** a code defect:

- **Chromium** does not launch in the sandbox (macOS
  `bootstrap_check_in ... Permission denied`), so the Playwright e2e suite cannot run
  there.
- **`docker compose`** (the Docker Desktop CLI plugin) is discovered under the real
  user's `~/.docker/cli-plugins`; when the sandbox overrides `HOME`
  (e.g. `HOME=/private/tmp`, needed so silo/Tilt can write) the plugin is not found
  and `docker compose ...` fails with `docker: unknown command: docker compose` /
  exit 125, while a normal-`HOME` `docker compose version` works. This blocks
  `nub run e2e`, `nub run dev:share`, and `nub run drill:backup-restore` in the
  sandbox only. On Linux CI the compose plugin is installed system-wide, so `HOME`
  is irrelevant and these run normally.

**Decision:** these executable proofs are run by the **driver in an unsandboxed,
real-`HOME` environment** and are the authoritative execution gate for the migration.
Codex structured review still gates the code; it must not reject solely on the
sandbox's inability to execute docker/Chromium. Driver evidence for phase-3:
`nub run drill:backup-restore` → `PASS backup/restore drill`, contentHash ==
blobHash, ACL public=200 / default-non-html=401, DB-dump-first snapshot order, 0
residual containers; `nub run dev:share` → smoke passes (seeded human sign-in +
minted-token CLI publish), and SIGINT to `scripts/devShare.ts` runs
`silo down --clean` to completion with 0 residual containers/volumes and
`.dev/agent.env` removed.

## 2026-07-03 — security audit deferrals (Allen decisions)

The whole-repo security ultra-audit (`uaudit-2026-07-03-ff6d8b`, `AUDIT.md`)
verified 11 findings. Seven were fixed in the phase-4 security packet. Two are
design/framework decisions reserved for Allen and are deferred here with their
proposed fixes; they remain `open` in `AUDIT.md` pointing at this entry.

- **F-03 / F-05 (high) — CLI authorize has no explicit approval step.**
  `apps/web/src/auth/cliFlow.ts:101-136` mints a one-time code from a
  cookie-authenticated `GET /cli/authorize` and redirects it to an
  attacker-chosen `127.0.0.1:<port>`. A local process that can open the
  user's browser (and the user has a live press session) can obtain a
  long-lived API token with no consent click. This is the ratified
  REQ-AUTH-004 ceremony ("after the user authenticates, the server
  redirects…"); hardening it with a mandatory same-origin, CSRF-protected
  approval screen materially changes that ratified flow, so it is Allen's.
  **Threat context:** requires local code execution on the user's machine
  already; the escalation is persistence (a durable token) rather than
  transient access. **Proposed fix:** server-owned pending-login state +
  nonce created before redirect, a confirmation page, and issue the loopback
  redirect only after a CSRF-protected POST approval. Keep PKCE. Add
  regression coverage for the approval gate. Decision needed: adopt the
  approval screen (amends REQ-AUTH-004) or accept the local-attacker risk
  for an org-internal tool.

- **F-04 (medium) — session and OAuth tokens stored plaintext in Postgres.**
  `apps/web/src/db/schema.ts:43-76` models `session.token`,
  `account.accessToken`, `account.refreshToken`, and `account.idToken` as
  plaintext `text` (this is Better Auth's own adapter schema). A read of the
  DB or a backup exposes replayable auth material. **Mitigation already in
  place:** the phase-3 backup runbook (`docs/ops.md`) treats the DB and its
  dumps as secret-bearing. **Proposed fix (Allen's call, framework-level):**
  hash session tokens before storage/lookup and encrypt provider tokens with
  a deployment key (or disable provider-token persistence if unused) — both
  require overriding Better Auth internals, so the tradeoff (security vs.
  framework divergence/upgrade risk) is Allen's. Deferred, not dismissed.

## 2026-07-03

- One production build failure is resolved in phase-1. `nub run build:web`
  completes One's production client/server build and SSR prerender after an
  app-level Vite transform rewrites `@tamagui/use-event`'s React namespace
  import before Rolldown emits the broken `React$<N>` read. The rejected first
  green build used `NODE_ENV=development`, so it did not prove this floor; the
  build wrapper now defaults to production mode, disables credential auth, uses
  non-secret build placeholders for prerender-time production config parsing,
  and fails closed if `apps/web/dist/` contains `*.development.js` artifacts.
  Runtime production boot validation is unchanged. Localnet and e2e still run
  the One dev server in this phase; production-representative serving remains
  phase-2 work, not an active production-build blocker.
- Reproducibility floor — intermittent cold-start e2e failures: RETIRED
  2026-07-03. The dev-server harness could fail browser tests on the first
  run after cold state (~2/9 observed) with clean reruns passing. Phase-2
  routes Playwright through a built production artifact served by `one serve`
  under the same non-production seeded localnet runtime env, and fixed the
  one remaining snapshot-read race in `e2e/magazine.spec.ts` with retrying
  web-first assertions (identical expected values). Driver evidence in
  `DELTA.md`: 3 consecutive maximally-cold `nub run e2e` runs, 80/80 each.
  Assertions were not weakened. The e2e API-context `Connection: close`
  mitigation was removed 2026-07-03 after a prod-server keep-alive
  experiment: 3 consecutive maximally-cold `nub run e2e` runs passed 80/80
  with default keep-alive and no `EPIPE`/`ECONNRESET` (evidence in
  `DELTA.md`). The mitigation is deleted for good; nothing about it remains
  active.
