# press — build loop

Instructions for the build loop. Start this in a fresh session from this repo
root once Allen says go. This file is the ephemeral plan (how/when); the
durable law lives in `VISION.md`, `SPEC.md`, `BRIEF.md`, `apps/web/BRIEF.md`.
When the build completes, absorb anything durable and delete this file.

## Ground rules

- Read `SPEC.md` + both BRIEFs before phase 0. Decisions there are ratified —
  do not re-ask them.
- Harness-first: each phase writes its failing verification before its
  implementation (TDD gate).
- Presence: this loop runs unattended-grade rigor regardless of who's watching.
  The Boundary in `BRIEF.md` holds absolutely: no push, no publish, no deploy,
  no live secrets, no Google OAuth. Commit locally at each phase end.
- Blocked protocol: never freeze on one question — accumulate questions,
  finish what's finishable, terminate `blocked: needs N decisions` with the
  list. Add answered questions to the relevant brief's Decisions.
- Budget: ≤ 3 verify-fix cycles per phase before declaring the phase blocked
  and moving to the next independent phase (if any) or terminating honestly.
- Each phase ends: harness green at its floor → fresh-context review
  (`/code-review` medium or an rl review gate) → address findings → local
  commit (conventional message, reference REQ IDs).
- Grafting: `~/0xbigboss/tamagui/takeout2` is the pattern source (Better Auth
  wiring in `src/features/auth`, upload route shape in
  `app/api/file/upload+api.ts`, Tamagui interface config). Copy liberally,
  adapt scope to `@press/*`, never import from takeout2 at runtime. Do NOT
  graft: Zero, native/EAS, hot-updater, SST, tko.
- Update `SPEC.md` test-traceability as tests land. Log infeasible floors to
  `DEVIATIONS.md`, per-round gaps to `DELTA.md` (beside the relevant brief).

## Prerequisites (verify before phase 0; if missing, stop and report)

- `bun`, `nub`, `docker` (compose) available; `nub run check` green on HEAD.
- `~/0xbigboss/tamagui/takeout2` readable (pattern reference).

## Phases

### Phase 0 — localnet + harness skeleton (the verifier exists before the work)

Goal: `nub run localnet` boots Postgres (docker compose) + placeholder server;
`nub run e2e` runs a Playwright suite (one smoke test) against it;
`nub run test` runs unit tests; `.github/workflows/ci.yml` runs check + test +
e2e headless. Env validation module per REQ-CFG-001/002 with unit tests
(fail-loud boot).
Done: all four commands exist and are green; CI file lints.

### Phase 1 — One app skeleton with design tokens (no unstyled milestone)

Goal: `apps/web` is a One + Tamagui app that boots in localnet. Define the
design tokens (type scale, spacing scale, palette, 2 self-hosted font
families) in the Tamagui config FIRST; `/` renders a minimal but styled
placeholder feed shell. Delete `apps/example` (clean break).
Verify: Playwright smoke + the objective design floors from
`apps/web/BRIEF.md` (no h-scroll, contrast, zero third-party requests, CLS,
≤ 2 typefaces) run against the placeholder in light + dark.
Done: floors green on the skeleton.

### Phase 2 — schema, Better Auth, and the pure ACL core

Goal: Drizzle schema (SPEC domain model) + migrations; Better Auth with
credential provider gated by `PRESS_ENABLE_CREDENTIAL_AUTH` (REQ-AUTH-002,
INV-5 boot-refusal test) and Google provider config-gated for prod; seeded
localnet users (owner, second-user, wrong-domain, external, admin). TDD the
pure ACL function (REQ-ACL-006): exhaustive unit table over REQ-ACL-001/005
lands red first.
Done: `nub run test` green incl. full ACL table; login via credential provider
works in a Playwright test.

### Phase 3 — publish API, storage, audit

Goal: REQ-PUB-001…009 with slug grammar, size caps, transactional blob+row
writes, argon2 password generation, soft-delete, ACL-filtered list endpoints.
TDD as failing integration tests against localnet first (real Postgres, real
FS under a temp storage dir).
Done: PUB integration tests green; every mutation writes an AuditEvent
(INV-6 asserted).

### Phase 4 — serving + the e2e ACL matrix

Goal: `/p/:collection/:file` per REQ-SRV-001…003 with the exact sandbox CSP.
Implement the full acceptance-criteria matrix from `SPEC.md` as the e2e suite.
Done: the entire SPEC acceptance checklist is green in `nub run e2e`.

### Phase 5 — the press CLI

Goal: `packages/cli` (`@press/cli`, bin `press`) per REQ-CLI-001…004 +
REQ-AUTH-004…006: loopback login flow (exchange endpoint testable without a
browser), keychain storage (macOS `security`), `PRESS_TOKEN` fallback, `--json`
everywhere. Repurpose or delete the template's `packages/core`/`packages/utils`
(follow their zshy build pattern; delete what press doesn't use).
Verify: e2e drives the real spawned binary — login (token minted via the
testable exchange), publish, list, page set, unpublish (BRIEF floor).
Done: CLI-driven e2e green; matrix rerun green.

### Phase 6 — the magazine surface

Goal: real feed + collection pages + login page per REQ-IDX-001…003, styled to
`apps/web/BRIEF.md` on the token system from phase 1, with seeded demo content
for screenshots.
Verify: objective design floors green in both schemes, then run the blind
screenshot oracle (3 fresh-context judges per the design brief; 2-of-3 quorum
on every dimension). Iterate on failing dimensions' evidence within budget.
Done: floors green + quorum passed (or honest `blocked` with judge evidence).

### Phase 7 — wrap

Goal: full harness green end-to-end from a clean localnet boot; SPEC
test-traceability table populated; `DELTA.md` summarizing remaining gaps and
proposed next steps; final local commit.
Terminal states: `done` | `blocked: needs N decisions (list)` |
`budget-exhausted (evidence)`.

## What the loop must leave for Allen (the Boundary handoff)

- Repo ready to push to `unrulysystems/press` (his trigger).
- A list of instance-creation steps he owns: Google OAuth client, DNS,
  `0xsend/press` manifests + image mirror, ESO secrets, deploy, attended
  real-Google final-gate walkthrough.
