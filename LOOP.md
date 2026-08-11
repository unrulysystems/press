# Loop: security ultra-audit findings (2026-08-11) — `fix/security-audit-fixes`

Mission: drive this branch to **interior-green** on the verified findings of
ultra-audit batch `uaudit-2026-08-11-7a71f5` (see `AUDIT.md` F-12..F-20; earlier
F-01..F-11 are now `resolved`) so the only remaining steps are Allen's boundary
calls on the three design/boundary findings (F-12/F-17, F-13, F-14) — a numbered
decision batch with proposed answers, plus the publish steps (push / merge
proposal). Work through the ADF loop (SPEC → PLAN → TDD → DEV → E2E). Unblock via
the ladder; the verifier — not confidence — decides when work is done.

## State (updated 2026-08-11 — rewrite each iteration; newest facts first)

- Branch `fix/security-audit-fixes`, HEAD `aa3c495`, tree dirty-only-by-design.
  Nothing pushed. Base: `ca8af24`.
- Basis commits: `aa3c495` (AUDIT.md amendment, F-12..F-20 verified open,
  F-01..F-11 resolved), `f7ea31d` (gitignore `AUDIT/` machinery output).
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

1. 2026-08-11 — **Republish-after-unpublish is a fresh publish** (F-18). When a
   PUT lands on an `archivedAt` row and the request carries no explicit
   visibility/allow/password options, the page starts from neutral state exactly
   like a first publish: `visibility=null`, `allowlist=[]`, and a password is
   generated (and returned once) only when the request asks for
   `visibility=password`. Overwrite of a LIVE page keeps prior settings (status
   quo). Why: silent resurrection of a stale password/allowlist is the defect —
   "resume last ACL" is neither documented nor least-surprise, and the old
   password would never be returned to the publisher. Provisional (ratified at
   review gate / by Allen at boundary).
2. 2026-08-11 — **Unlock-cookie invalidation without a schema change** (F-15/19).
   Bind the cookie signature to a digest of the page's current `passwordHash`
   (null-marker when no hash): sign `HMAC(secret, pageId.expiry.passwordDigest)`;
   verify against the current row's hash, so reroll/overwrite-publish of a
   password page invalidates outstanding unlock cookies immediately. No new
   column, no migration (schema changes stay out of this loop's interior).
   Provisional.
3. 2026-08-11 — **Small dedicated caps for anonymous bodies** (M-3).
   `/api/cli/exchange` JSON and `/p/:c/:f` password-unlock text get streaming
   byte caps far below `PRESS_MAX_UPLOAD_BYTES` (codes/passwords are tiny),
   rejecting oversized bodies with 413 before buffering. The publish upload cap
   is unchanged. Provisional.
4. 2026-08-11 — **Keychain test seam is test-build-only** (F-16). Gate
   `PRESS_E2E_KEYCHAIN_FILE` behind a build-time define that only
   `buildCliBinary.ts` in test/e2e builds sets; release binaries never compile
   the file backend in. Hermetic e2e keeps its seam. Provisional.
5. 2026-08-11 — **Boundary batch (Allen) carries proposed answers, not stuck
   work** (F-12/17, F-13, F-14, see Work plan unit 6). The loop fixes only
   ratified-boundary-adjacent effects after answers land; nothing here is
   interior.

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
