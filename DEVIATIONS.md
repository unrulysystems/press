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
