# loop.md — press v1.2: CI harness completeness, e2e mitigation evidence

Successor to the absorbed v1.1 plan (`loop.md@fe84121`, wrapped at `b625c2f`).
Two bounded gaps remain inside the Boundary; this loop closes them. Authored
by the driver on 2026-07-03; Allen may amend or reject on return.

## Context

- `.github/workflows/ci.yml` runs `nub run check`, `nub run test`, and
  `nub run e2e` only. The v1.1 gates — `nub run build:web` (production build
  - fail-closed dev-artifact scan) and `nub run smoke:image` (container
    boot-refusal, feed, exact CSP) — are not wired into CI, so a push would not
    protect them. CI itself still cannot execute until Allen pushes (recorded
    in `DELTA.md`).
- `DEVIATIONS.md` retains the e2e `Connection: close` API-context mitigation
  with no evidence whether it is still needed under `one serve` prod serving.

## Law

Inherits every v1/v1.1 constraint: Boundary absolute (no push, publish,
deploy, DNS, live secrets, real Google); secrets never in argv/logs/repo
(INV-4); harness-first; deviation changes require recorded evidence; driver
commits at phase end after review; ≤ 3 worker attempts per phase; blocked
protocol on exhaustion.

## Non-goals

- Executing CI (needs push — Allen's).
- Anything on the Boundary handoff list in `DELTA.md`.

## Phases

### phase-0-ci-gates: wire build:web and smoke:image into CI

- **Depends on:** none
- **Packet scope:** `.github/workflows/**`, `DELTA.md`
- **Acceptance:** `actionlint .github/workflows/ci.yml` green;
  `nub run check && nub run test` green; the workflow runs the full harness
  (check, test, e2e, build:web, smoke:image) with bounded timeouts on
  `ubuntu-latest` (docker + compose are available there); `DELTA.md` notes
  that CI executes only after Allen's push.
- **Description:** CI is the harness's unattended home; it must run every
  floor the local wrap ran. Order the jobs/steps so cheap gates fail first.

### phase-1-connclose-evidence: retire or re-scope the Connection: close mitigation

- **Depends on:** phase-0-ci-gates
- **Packet scope:** `e2e/**`, `DELTA.md`, `DEVIATIONS.md`
- **Acceptance:** `nub run check && nub run test` green; the mitigation is
  either removed (with the driver's ≥3 consecutive cold-state 80/80
  `nub run e2e` runs recorded in `DELTA.md`) or kept with the experiment's
  failure evidence recorded in `DEVIATIONS.md`. Assertions unchanged either
  way.
- **Description:** Remove the `Connection: close` header from the e2e API
  contexts; the driver runs the cold evidence series. If any run fails for
  mitigation-shaped reasons (connection reuse against `one serve`), restore
  the mitigation and record the evidence honestly.

## Wrap

On `done`: refresh `DELTA.md` (dated entry + Boundary handoff), verify tree
committed and full harness green (`check`, `test`, `e2e`, `build:web`,
`smoke:image`), absorb this file and delete it, as its predecessors
prescribed.
