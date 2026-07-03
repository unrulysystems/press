# loop.md — press v1.1: production build, prod-representative serving, image

Successor to the absorbed v1 loop plan. v1 terminated done (all 8 phases,
commit `614e7f5`). This loop closes the one remaining pre-Boundary blocker
recorded in `DEVIATIONS.md` and `DELTA.md`: the One production build failure,
and the work it unblocks. Authored by the driver on 2026-07-03 while Allen was
away; Allen may amend or reject on return.

## Context

- `one build --platform=web` fails during SSR prerender with
  `ReferenceError: React$<N> is not defined` (N varies per build: 14, 15, …)
  thrown from `dist/server/assets/react-dom-*.js` while importing built SSR
  page assets (e.g. `_collection_-ssr-*.js`). Reproduced 2026-07-03 on
  `one@1.19.4`, `react@19.2.0`, `vite@8.0.3`.
- Because of this, localnet + e2e run the Vite dev server with the
  `Connection: close` mitigation (commit `a793eeb`), and a cold-start e2e
  flake deviation is recorded. The root fix for both is
  production-representative serving.
- The container image and deploy manifests are blocked behind a green build.

## Law

`SPEC.md`, `BRIEF.md`, `apps/web/BRIEF.md` are ratified — never re-ask their
Decisions. This plan inherits every v1 constraint:

- **Boundary is absolute:** no `git push`, no package/image publish or mirror,
  no deploy, no DNS, no live secrets, never real Google OAuth (localnet uses
  the seeded credential provider, REQ-AUTH-002).
- Secrets never in argv, logs, or committed files (INV-4).
- Harness-first TDD inside every phase: the failing verification lands before
  the implementation that turns it green.
- Traceability updates in `SPEC.md` as tests land; infeasible floors →
  `DEVIATIONS.md`; per-round gaps and ratification asks → `DELTA.md`.
- Driver commits locally at each phase end (conventional message, REQ IDs)
  after phase-review findings are addressed.
- Budget: ≤ 3 worker attempts per phase. On exhaustion follow the blocked
  protocol: accumulate open questions, finish what is finishable, terminate
  `rl done --blocked "needs N decisions: <list>"`.

Allowed intervention space for the build fix, in order of preference:
app-level config (`apps/web/vite.config.ts` / One config), a committed
dependency patch (`bun patch` on `one` or related packages, patch checked in),
or a One version change that stays green across the whole harness. Forking One
or vendoring its source is out of scope — if nothing in the allowed space
converges, record the evidence in `DEVIATIONS.md` and block honestly.

## Non-goals

- Publishing/mirroring the image to `0xsend/press` (Allen).
- Kubernetes/deploy manifests, ESO secret provisioning, DNS (Allen; they
  depend on deploy-target decisions not yet ratified).
- The two open ratifications in `DELTA.md` (password-as-collection-default,
  judge G's link-affordance dissent) — Allen's, not loop work.

## Phases

### phase-0-repro: failing build gate + root cause

- **Depends on:** none
- **Packet scope:** `scripts/**`, `package.json`, `e2e/**`, `DELTA.md`
- **Acceptance:** a `nub run build:web` (or equivalently named) gate exists
  that runs `one build --platform=web` and currently fails with the
  ReferenceError; a root-cause note lands in `DELTA.md` identifying, with
  file/line evidence from `dist/server` output and One/Vite source in
  `node_modules`, where the `React$<N>` binding is renamed and dropped
  (which chunk boundary, which transform). `nub run check && nub run test`
  stay green.
- **Description:** The verifier exists before the fix. Root-cause with the
  local tree only: build output in `apps/web/dist/server`, One CLI source
  (`node_modules/one/dist/esm/cli/build.mjs` prerender/import step), and the
  rollup/vite chunking that produces `react-dom-*.js`. No guessing in the
  note — every claim cites a file.

### phase-1-fix: green production build

- **Depends on:** phase-0-repro
- **Packet scope:** `apps/web/**` (config only, no feature changes),
  `patches/**`, `package.json`, `lock.yaml`, `DEVIATIONS.md`, `DELTA.md`
- **Acceptance:** the phase-0 build gate exits 0; `nub run check && nub run
  test && nub run e2e` all green (e2e still on dev server in this phase);
  the fix is the minimal intervention from the allowed space, and `DELTA.md`
  records what was chosen and why.
- **Description:** Turn the phase-0 gate green. Prefer app-level
  config; else a committed `bun patch`; else a One version change validated
  against the full harness. Update the `DEVIATIONS.md` entry to reflect the
  new state (resolved or narrowed).

### phase-2-prod-serve: production-representative e2e

- **Depends on:** phase-1-fix
- **Packet scope:** `scripts/**`, `e2e/**`, `playwright.config.ts`,
  `apps/web/**`, `package.json`, `DEVIATIONS.md`, `DELTA.md`, `SPEC.md`
- **Acceptance:** `nub run e2e` runs the full suite against the built
  production server (`one serve` or equivalent) booted by localnet from a
  clean state, 80/80 green from a cold boot; the dev-server path remains
  available for `nub run localnet` development; the `Connection: close`
  mitigation and the cold-start-flake deviation are retired or explicitly
  re-scoped in `DEVIATIONS.md` with evidence (≥3 consecutive cold-boot green
  runs).
- **Description:** This is the root fix the v1 wrap deferred. Serve the real
  build in e2e, prove cold-boot determinism, and update the deviation record
  honestly — do not retire it without the evidence.

### phase-3-image: local container image + smoke

- **Depends on:** phase-2-prod-serve
- **Packet scope:** `Dockerfile`, `.dockerignore`, `compose.yaml`,
  `scripts/**`, `e2e/**`, `package.json`, `DELTA.md`, `SPEC.md`
- **Acceptance:** `docker build` succeeds locally producing a runnable image;
  a smoke gate (script or e2e subset) boots the container against localnet
  Postgres with localnet env and proves: boot-refusal without required env
  (INV-5 / REQ-CFG-001), a published page served at `/p/…` with the exact
  sandbox CSP, and the magazine feed rendering. No push, no tags beyond
  local. `nub run check && nub run test && nub run e2e` stay green.
- **Description:** Image build + smoke only. Publishing to `0xsend/press`
  and manifests stay on Allen's handoff list.

## Wrap

On `done`: update `DELTA.md` (dated entry: what changed, deviation status,
refreshed Boundary handoff list), verify working tree committed and full
harness green from clean boot, then absorb this file — its surviving law goes
to `DEVIATIONS.md`/`DELTA.md`/`SPEC.md` — and delete it, as the v1 loop.md
prescribed for itself.
