# Loop: security ultra-audit findings (2026-08-11) — `fix/security-audit-fixes`

Mission: drive this branch to **interior-green** on the verified findings of
ultra-audit batch `uaudit-2026-08-11-7a71f5` (see `AUDIT.md` F-12..F-20; earlier
F-01..F-11 are now `resolved`) so the only remaining steps are Allen's boundary
calls on the three design/boundary findings (F-12/F-17, F-13, F-14) — a numbered
decision batch with proposed answers, plus the publish steps (push / merge
proposal). Work through the ADF loop (SPEC → PLAN → TDD → DEV → E2E). Unblock via
the ladder; the verifier — not confidence — decides when work is done.

## State (updated 2026-08-11 — rewrite each iteration; newest facts first)

- Branch `fix/security-audit-fixes`, HEAD `23de6ee`, tree clean. Nothing pushed.
  Base: `ca8af24`.
- **Unit 1 DONE (iteration 1).** Commit `23de6ee` fix(publish): republish
  neutral + first-publish collection race (F-18, M-1); basis `aa3c495` AUDIT
  amendment, `f7ea31d` gitignore `AUDIT/`, `3e356d9` charter. TDD: two new e2e
  floors observed red (F-18 resurrection + M-1 500 reproduced) then green;
  e2e/publish.spec.ts 18/18; `nub run check` green; `nub run test` 200 pass / 0
  fail.
- **Review gate 1: APPROVE** (rl review job `review-1786461611081-rdmmgt`,
  structured, range `ca8af24..HEAD`; reviewer verified the floors and ratified
  the unit contract, incl. losing non-owner → 403 not 500). Decision 1 ratified
  at the gate (final ratification: Allen at boundary).
- **Next: Unit 2 — unlock cookie bound to password (F-15/19).**
  _Superseded — unit 2 & 3 completed below._
- **Unit 2 DONE (iteration 2).** Commit `2bd38bd` unlock cookie bound to
  sha256(passwordHash) — reroll/republish invalidates outstanding cookies, no
  migration. TDD red (cookie still opened after reroll) → green. e2e
  publish.spec.ts 19/19; check green; test 201 pass / 0 fail. **Review gate 2
  APPROVE** (`review-1786462442671-4cxskk`).
- **Unit 3 DONE (iteration 3).** Commits `f4b88a7` keychain seam compiled out
  of release binaries (F-16), `d551339` verifier never clobbers `artifacts/cli/press`,
  `4a626ed` fail-closed fingerprint. 2 review fix-up rounds: reviewer caught the
  release.yml ordering clobber (reproduced: artifact SHA changed seam-free→seam-on)
  and the silent-read flaw. **Review gate 3 APPROVE** (`review-1786464829729-ra88p9`).
  test:cli:binary green; e2e/cli.spec.ts 4/4.
- **Next: Unit 4 — localnet Postgres loopback (F-20).**
  _Superseded — units 4-6 completed below._
- **Unit 4 DONE (iteration 4).** Commit `ded3ee3` compose loopback + e2e
  fail-closed floor (F-20), `49cfb57`/`4c8d364`/`6e03add` review fixes (docker
  exit-status fail-closed, positive loopback-host predicate, bounded probe).
  **Review gate 4 APPROVE** (`review-1786467084558-yhpvtw`). Container binding
  now `127.0.0.1:54329->5432/tcp`.
- **Unit 5 DONE (iteration 5).** Commit `ef77e60` cap anonymous bodies (8 KiB
  CLI exchange / 16 KiB password gate, 413 before buffering, stream cancel) +
  malformed-path 400s (M-2/M-3), `12ce41c`, `91e4bd8`. **Review gate 5 APPROVE**
  (`review-1786468790723-qxq128`).
- **Unit 6 DONE (iteration 6) — interior green.** Floors: `nub run check` green;
  `nub run test` 205 pass / 0 fail (incl. new reader suite); suite surface green
  (publish 21/21, cli 4/4, remaining specs 79/79 — the silo→Tilt orchestrator
  needs a PTY that the harness env lacks, so the suite ran against the manually
  booted localnet, same compose+one stack; CI runs the `nub run e2e` path with a
  TTY). test:cli:binary green incl. seam-gate floor.
- **Terminal state: interior-green achieved; branch ready for Allen's batch    (below) and the publish steps (push / merge proposal). Nothing pushed.**
- Open verified findings targeted by this loop: F-15/F-19 (unlock cookie
  survives password reroll), F-16 (keychain test seam honored by packaged CLI),
  F-18 (republish resurrects stale visibility/allowlist/passwordHash), F-20
  (localnet Postgres 0.0.0.0 + static creds). Boundary-batch (Allen only):
  F-12/F-17 (CLI authorize has no consent step → long-lived token theft),
  F-13 (admin role sticky after PRESS_ADMIN_EMAILS removal), F-14 (unconfigured
  Better Auth admin plugin exposes role-management APIs).
- Own audit adds interior items the ultra-audit did not adopt: M-1 (publish
  collection-insert race → spurious 500; `movePage` already uses
  `onConflictDoNothing`, `publishPage` does not), M-2 (malformed %-encoding on
  `/api/pages` + `/api/collections` → 500 instead of 400), M-3 (anonymous
  unbounded bodies: `/api/cli/exchange` `request.json()`, `/p/:c/:f` POST
  `request.text()`; publish HTML is already stream-capped).
- Resume-memory: read `AUDIT.md` (ledger + full finding text), this LOOP.md, then
  the diff of `aa3c495..HEAD`. `DEVIATIONS.md` 2026-07-04/07-06 hold prior
  ratifications that still bind (provider-token nulling, F-03/05 deferral).

## Decisions (append-only; do not re-litigate)

<!-- dated entries; mark each "ratified (human)" or "provisional (driver)".
     provisional entries carry rationale + consult verdict if one ran -->

6. 2026-08-11 — **B-1 A (Allen, ratified): CLI authorize gains a consent
   step.** Server-owned pending-login record (state/port/challenge bound
   server-side), same-origin approval page, loopback redirect only after a
   CSRF-protected POST; code still minted only at approval. Amends REQ-AUTH-004.
7. 2026-08-11 — **B-2 A (Allen, ratified): config is the admin source of
   truth.** Role derived at every sign-in (promote AND demote) and resolved
   from PRESS_ADMIN_EMAILS at every authorization use (tokens, session reads,
   whoami); the role column is a cache. Amends REQ-AUTH-007.
8. 2026-08-11 — **B-3 A (Allen, ratified): drop the Better Auth admin()
   plugin.** press moderation is read-all + unpublish via decideAcl; the plugin
   surface is removed at the source.

## Follow-up pass (B-1..B-3, ratified 2026-08-11)

- Unit B-3 (drop admin plugin) → Unit B-2 (config-derived role) → Unit B-1
  (consent screen + SPEC amendments). Same TDD + review-gate discipline; one
  review per unit.

1. 2026-08-11 — **Republish-after-unpublish is a fresh publish** (F-18). When a
   PUT lands on an `archivedAt` row and the request carries no explicit
   visibility/allow/password options, the page starts from neutral state exactly
   like a first publish: `visibility=null`, `allowlist=[]`, and a password is
   generated (and returned once) only when the request asks for
   `visibility=password`. Overwrite of a LIVE page keeps prior settings (status
   quo). Why: silent resurrection of a stale password/allowlist is the defect —
   "resume last ACL" is neither documented nor least-surprise, and the old
   password would never be returned to the publisher. **Ratified at review gate
   1 (2026-08-11, rl review APPROVE); final ratification: Allen at boundary.**
2. 2026-08-11 — **Unlock-cookie invalidation without a schema change** (F-15/19).
   Bind the cookie signature to a digest of the page's current `passwordHash`
   (null-marker when no hash): sign `HMAC(secret, pageId.expiry.passwordDigest)`;
   verify against the current row's hash, so reroll/overwrite-publish of a
   password page invalidates outstanding unlock cookies immediately. No new
   column, no migration (schema changes stay out of this loop's interior).
   **Ratified at review gate 2 (2026-08-11, APPROVE); final ratification: Allen**
   **at boundary.**
3. 2026-08-11 — **Small dedicated caps for anonymous bodies** (M-3).
   `/api/cli/exchange` JSON and `/p/:c/:f` password-unlock text get streaming
   byte caps far below `PRESS_MAX_UPLOAD_BYTES` (codes/passwords are tiny), rejecting oversized bodies with 413 before buffering. The publish upload cap
   is unchanged. **Ratified at review gate 5 (2026-08-11, APPROVE); final
   ratification: Allen at boundary.**
4. 2026-08-11 — **Keychain test seam is test-build-only** (F-16).
   `buildCliBinary` injects `process.env.PRESS_TEST_BUILD` at compile time —
   "1" for hermetic test/e2e binaries, "0" for release (`--release` in
   release.yml); `keychain.ts` honors `PRESS_E2E_KEYCHAIN_FILE` only when the
   compiled switch is on, and the verifier never writes to `artifacts/cli/press`
   (release workflow order: build --release → verify → package). Source runs
   keep the seam enabled. **Ratified at review gate 3 (2026-08-11, rl review
   APPROVE); final ratification: Allen at boundary.**
5. 2026-08-11 — **Boundary batch (Allen) carries proposed answers, not stuck
   work** (F-12/17, F-13, F-14, see Work plan unit 6). The loop fixes only
   ratified-boundary-adjacent effects after answers land; nothing here is
   interior. **Emitted at done — see `## Boundary batch for Allen` below.**

## Work plan (ADF per unit)

1. **Unit 1 — republish semantics + collection race (F-18, M-1):**
   `apps/web/src/publish/routes.ts` publishPage: archived-row republish starts
   neutral per Decision 1; collection insert gains `onConflictDoNothing` +
   re-read (mirror `movePage`). Establishes: stale ACL/password can never
   resurrect; concurrent first publishes to a new collection no longer race.
   Defers: cookie invalidation (Unit 2).
2. **Unit 2 — unlock cookie bound to password (F-15/19):**
   `apps/web/src/publish/pagePasswordCookie.ts` (+ `serving.ts` verify call
   site). Establishes: password reroll immediately rejects prior unlock cookies.
   Defers: nothing.
3. **Unit 3 — keychain seam gating (F-16):** `packages/cli/src/keychain.ts` +
   `scripts/buildCliBinary.ts` (build define; release vs test builds).
   Establishes: packaged release binary ignores `PRESS_E2E_KEYCHAIN_FILE`;
   hermetic e2e still works. Defers: nothing.
4. **Unit 4 — localnet Postgres loopback (F-20):** `compose.yaml` port binding
   `127.0.0.1:${PRESS_POSTGRES_PORT}:5432` (+ any other host-wide mappings in
   silo/tilt). Establishes: dev DB unreachable from the LAN. Floor: `nub run e2e`
   still green (host tooling reaches 127.0.0.1). Defers: nothing.
5. **Unit 5 — input robustness (M-2, M-3):** `routes.ts` path parsing returns
   400 on decode failures; byte caps on the two anonymous body reads per
   Decision 3. Establishes: malformed URLs 4xx, oversized anonymous bodies 413.
   Defers: nothing.
6. **Unit 6 — harness consolidation + decision batch:** full `nub run check` /
   `nub run test` / `nub run e2e` green; any new floors for classes found
   re-land as regression tests in the units above; independent review gate
   (below) over the whole range. Emits the numbered boundary batch for Allen
   (F-12/17, F-13, F-14) each with evidence + proposed answer. Done = interior
   green AND the batch handed over.

## Verification floors

- `nub run check` (tsgo -b, oxlint, oxfmt --check) → green, no new warnings.
- `nub run test` (bun test packages, apps/web/src, scripts) → green; every unit
  adds its regression test observed red first (TDD): republish-neutral (Unit 1),
  reroll-invalidates-cookie (Unit 2), seam-gated binary (Unit 3), malformed-path
  400 + 413 caps (Unit 5), collection-race (Unit 1).
- `nub run e2e` against localnet → green (BRIEF floor: full acceptance list,
  real CLI binary, sandbox CSP assertions, boot fail-closed). Boots its own silo;
  must run after Units 1-5 (they touch the served surfaces).
- Review gate — harness first, briefed reviews: every review carries its unit's
  contract (intended outcome, what to judge now, invariants, acceptance
  evidence, work deferred to a later unit); declared deferred work is not a
  finding, current-unit regressions and contract violations are. Severity floor
  `major` (reviewer's own scale): findings at or above it block, a below-floor
  reject does not; max 3 review→fixup rounds per reviewed unit. A finding the
  harness should have caught earns a new floor, not just a patch. Driver never
  self-approves.
- Re-audit at done: `rl ultra-audit start --profile security --scope-paths '**'`
  may re-run to confirm the open set, but green floors + review gate are the
  decision; the audit re-run is evidence, not a gate (its F-12/17, F-13, F-14
  remain the batch).

## Unblocking ladder

Investigate (two focused passes) → doctrine (Decisions here, BRIEF/SPEC
Decisions, `doctrine.md` in the loop-brief skill, memory) → `rl consult` with
evidence + candidate approaches + spec excerpts → provisional decision (dated
entry above) → accumulate for the human (irreversible / scope-changing /
Boundary items only).

## In-session edit policy

The driver edits directly when the fix is finding-sized (≤ ~2 files, mechanical,
fully understood). After any in-session edit: run the owning gates and commit
conventionally — the edit lands in its unit's review scope; the driver never
self-approves. Larger or design-shaped work goes to a cook packet. Never mix
in-session edits with an in-flight worker on the same files.

## Boundaries — NEVER

- Never push, open PRs, or merge — publish is the human's, per-artifact.
- Never touch live secrets or biometrics; never reroute around auth failures —
  surface and stop.
- Never amend SPEC/BRIEF or ratify Decisions without Allen; provisional
  decisions stay provisional until the review gate + Allen.
- Never add or run DB schema migrations (Decision 2 is migration-free by
  design); never touch Google OAuth config, Docker image publish, GitHub release
  tooling, or the prod deploy env.
- Never implement F-12/17, F-13, F-14 unilaterally — they are the decision batch
  for Allen, each shipped with evidence + a proposed answer.

## Known pre-existing failures — do not chase (cited evidence only)

- None cited on this branch. (Prior `resolved` findings are closed by
  `uaudit-2026-08-11-7a71f5`, not chased.)

## Boundary batch for Allen (decision batch at done — 2026-08-11)

The interior is green; these three are Allen-only (auth/security boundary +
SPEC amendments). Each carries evidence and a proposed answer; answering turns
them into ratified Decisions the loop can apply on a follow-up pass.

**B-1 — F-12/F-17 (high): CLI authorize has no consent step.**
Evidence: `cliFlow.ts` mints a code from any authenticated GET with caller-chosen
loopback port/challenge/state (server never binds state); exchange mints a
no-expiry token; there is no approval UI at all — REQ-AUTH-004's "after the user
authenticates" is satisfied by the login page, not the authorize page. Proposed
answer (recommended, matches the advisory): server-owned pending-login record
(state+port+challenge bound server-side), same-origin approval page, loopback
redirect only after CSRF-protected POST; amends REQ-AUTH-004. Alternative:
accept the documented risk (local process / any webpage with an ambient session)
and reduce severity in DEVIATIONS/README. Needs a SPEC amendment either way.

**B-2 — F-13 (high): admin role is sticky after PRESS_ADMIN_EMAILS removal.**
Evidence: session-create hook only promotes; verifyApiToken/ACL read persisted
`user.role`; REQ-AUTH-007 defines admins by configured email. Proposed answer
(recommended): config is the source of truth — derive role at every sign-in
(demote too) AND resolve token role from `PRESS_ADMIN_EMAILS` at use-time
(fail-closed when unlisted); the `role` column becomes a cache. Simple, no
migration; test removes an email and asserts the next session/token loses admin.

**B-3 — F-14 (high): unconfigured Better Auth admin plugin surface.**
Evidence: `admin()` mounted with defaults; the auth catch-all forwards GET/POST,
so admin-role sessions reach set-role/create-user/ban/impersonate/list-users —
far beyond the SPEC's admin scope (read-all + unpublish). Proposed answer
(recommended): drop the `admin()` plugin; press moderation is ACL-only and
impersonation support can be added deliberately if ever wanted. Alternative:
restrict `admin({ access })` to ban/unban/impersonate only.

Answer format: B-1 A|B, B-2 A, B-3 A|B — ratified entries get appended to
Decisions and a follow-up packet lands the chosen fixes.

## Terminal states & budget

- **done:** Units 1-6 all green — `nub run check`, `nub run test`, `nub run e2e`
  pass with cited output; new regression floors land with their units and stay
  green; review gate approves the range (no findings at/above major, or
  below-floor fixups accepted ≤3 rounds); the F-12/17, F-13, F-14 decision batch
  is written for Allen. Then stop the loop, update State, and write the handoff
  for Allen's boundary steps (answer the batch; push / merge proposal).
- **blocked:** numbered decision batch, each with evidence + a proposed answer;
  keep working independent units until only the batch remains.
- **budget:** hard cap **6 iterations** for the campaign (numeric, set at
  authoring; raising it is Allen's) — or, earlier, three consecutive iterations
  without measurable movement on any checklist item → stop honestly with what
  was tried and why it cannot converge.
