# loop.md — press v1.3: upstream reconcile, dev share, pre-launch hardening, 0.1.0

Successor to the absorbed v1.2 plan (`loop.md@ca8d601`, wrapped at `057c83d`).
Authored by the driver on 2026-07-03 from Allen's attended direction (chat,
2026-07-03 morning): unravel the One/Rolldown workarounds against upstream,
build the shared human+agent localnet, close pre-launch verification gaps,
then cut a clean feat-only 0.1.0 history. Allen may amend or reject live.

## Context

- Repo pushed to `unrulysystems/press` (private) this morning; first CI run
  of the full harness is green (run 28665687480, 5m38s).
- Three upstream workarounds are active, all confirmed locally, none filed
  or verified fixed upstream: (a) the `press:tamagui-use-event-react-import`
  Vite pre-transform in `apps/web/vite.config.ts` covering the Rolldown
  namespace-import declaration drop (`React$N`) — we run vite 8.0.3 /
  rolldown 1.0.0-rc.12; vite is at 8.1.3 upstream, and Rolldown's tracker
  has a family of "referenced binding dropped" fixes (#4745, #9502, #9515,
  #9961 closed 2026-07-02); (b) the bare `/api/collections` catch-all
  delegation and (c) the 413 bounded-body-drain, both app-level fixes in
  `apps/web/src/publish/routes.ts` accommodating `one serve` (pinned
  one@1.19.4; upstream at 1.20.2; `fix(one): recover router paths with url
fallback` in 1.19.5 is possibly related to (b)).
- `nub run localnet` seeds users/collections but prints only the base URL;
  no who's-who card, no pre-minted agent API token — a human+agent shared
  session requires reading `localnetFixtures.ts` and scripting token mint.
- Better Auth rate limiting is a ratified BRIEF Decision ("rate limiting
  on") with no e2e proving 429 behavior.
- No backup/restore drill exists; data durability is untested.
- No adversarial security pass has run over auth/ACL/publish/serving.
- History is 16 mixed commits (feat/fix/docs/chore phases); all packages at
  0.0.0. Allen ratified: squash to feat-only commits, launch as 0.1.0.
- Allen's ratifications this morning (committed `a6b0d2f`): collection
  `defaultVisibility` excludes `password`; entry titles stay hover-only.

## Law

Inherits every prior constraint: Boundary absolute — no push of any ref
(branches OR tags), no publish (npm/image), no upstream issue filing (drafts
only), no GitHub settings mutations, no deploy, DNS, live secrets, or real
Google. Secrets never in argv/logs/repo (INV-4); localnet fixture
credentials are committed non-secrets and may be printed; minted localnet
tokens go to gitignored files, not stdout. Harness-first; deviation and
workaround changes require recorded evidence, never assertion; driver
commits at phase end after review; ≤ 3 worker attempts per phase; blocked
protocol accumulates questions and terminates, never freezes.

## Non-goals

- Anything on the Boundary handoff list: push/force-push, CI re-runs,
  OAuth client, DNS, image mirror/manifests, ESO, deploy, walkthrough.
- Filing the drafted upstream issues (Allen publishes).
- GitHub repo settings (branch protection, secret scanning, dependabot) —
  handoff item.
- The attended macOS keychain `press login` test — Allen's machine.
- Tilt/silo tooling — ratified out for v1 (compose + scripts is the
  altitude; revisit only if press grows services).

## Phases

### phase-0-upstream-reconcile: bump one/vite, retire workarounds on evidence

- **Depends on:** none
- **Packet scope:** `apps/web/package.json`, `lock.yaml`,
  `apps/web/vite.config.ts`, `apps/web/src/publish/routes.ts`,
  `docs/upstream/**`, `DELTA.md`, `DEVIATIONS.md`
- **Acceptance:** full harness green in the final adopted state (`check`,
  `test`, `e2e`, `build:web`, `smoke:image`); `DELTA.md` records the
  experiment matrix (each bump x each workaround removal, with the exact
  failure or pass evidence); for every workaround that survives, a filed-
  ready issue draft exists under `docs/upstream/` (repro steps, versions,
  evidence file:line cites); no workaround is deleted without a green
  harness proving it unnecessary.
- **Description:** Bump one 1.19.4 → 1.20.2 and vite 8.0.3 → 8.1.3
  (respect One 1.20.2's supported vite peer range if it differs — One's
  range wins). With bumps installed, attempt each workaround removal
  independently: (a) the use-event pre-transform, (b) the bare
  `/api/collections` delegation. The 413 bounded-drain stays regardless —
  it is correct server hygiene, but draft its upstream issue. Outcomes:
  bump green + workaround removable → adopt both; bump green + workaround
  still needed → adopt bump, keep workaround, draft issue; bump itself
  red for unrelated reasons → revert to pinned versions, record evidence,
  draft issues, stay as-is. Honest evidence over adoption.

### phase-1-dev-share: shared human+agent localnet session

- **Depends on:** phase-0-upstream-reconcile
- **Packet scope:** `scripts/**`, `apps/web/src/auth/**`, `package.json`,
  `.gitignore`, `DELTA.md`, `README.md`
- **Acceptance:** `nub run check && nub run test` green; `nub run dev:share`
  boots localnet (dev-server mode by default, `--server=prod` passthrough),
  prints a who's-who card (seeded users + passwords + roles, collections +
  visibilities, base URL, page URLs) — fixture credentials are committed
  non-secrets, printing is allowed; mints a localnet API token for an agent
  identity and writes it to gitignored `.dev/agent.env` (`PRESS_TOKEN=...`,
  `PRESS_URL=...`), printing the file path, never the token; server stays up
  until SIGINT with clean teardown semantics matching `localnet.ts`; a
  scripted smoke (curl credential sign-in as the human + one real-CLI
  publish using `.dev/agent.env`) proves both actors work against the same
  instance; `.dev/` is gitignored.
- **Description:** The gap between "localnet boots" and "a human and an
  agent driver can immediately share it" is onboarding friction paid every
  session. Reuse `scripts/localnet.ts` (flag or thin wrapper, no fork of
  its boot logic); reuse the existing token-mint code path the e2e suite
  uses rather than inventing one.

### phase-2-rate-limit-evidence: prove the 429 floor

- **Depends on:** phase-1-dev-share
- **Packet scope:** `apps/web/src/auth/**`, `e2e/**`, `SPEC.md` (traceability
  row only), `DELTA.md`, `DEVIATIONS.md`
- **Acceptance:** an e2e proves repeated failed credential sign-ins receive
  429 within a bounded, deterministic window (thresholds env-configurable so
  the test is fast and non-flaky; production defaults unchanged); full e2e
  suite green including the new spec; if Better Auth rate limiting turns out
  to be off or unreachable in this integration, the phase records that
  honestly in `DEVIATIONS.md` with a proposed fix instead of shipping a
  gamed assertion.
- **Description:** "Rate limiting on" is a ratified Decision with no
  verifier. Add the missing floor. Do not weaken any existing assertion;
  do not slow the suite materially (target: additive seconds, not minutes).

### phase-3-backup-restore: durability drill

- **Depends on:** phase-2-rate-limit-evidence
- **Packet scope:** `scripts/**`, `docs/ops.md`, `package.json`, `DELTA.md`
- **Acceptance:** `nub run drill:backup-restore` (or equivalent script)
  performs, against a seeded localnet: pg_dump + blob-dir snapshot →
  full teardown → restore into a fresh boot → verification that a published
  page round-trips (page row present, blob byte-identical by contentHash,
  ACL behavior intact via HTTP probe); the drill runs green locally and its
  evidence (driver-run if the worker sandbox cannot) is recorded in
  `DELTA.md`; `docs/ops.md` documents the backup and restore procedure for
  a production operator (what to snapshot, in what order, and why: blob
  before DB or DB before blob — pick and justify the crash-consistent
  order).
- **Description:** Data durability is the launch risk no current test
  touches. The drill is the harness for the ops runbook — the doc describes
  exactly what the script proves.

### phase-4-security-scrub: adversarial pass over the trust surfaces

- **Depends on:** phase-3-backup-restore
- **Packet scope (fixes):** `packages/core/src/**`, `apps/web/src/**`,
  `packages/cli/src/**`, `e2e/**`, `DELTA.md`, `DEVIATIONS.md`
- **Acceptance:** a driver-run adversarial review (rl ultra-review over the
  full branch range, or ultra-audit scoped to auth/ACL/publish/serving/CLI
  token handling) completes with verified findings; every confirmed finding
  is either fixed by a worker packet (with a regression test where the
  finding is testable) or recorded in `DEVIATIONS.md`/`DELTA.md` with
  severity and rationale if deferred to Allen; full harness green after
  fixes.
- **Description:** The harness proves spec'd behavior; nobody has hunted
  for unspec'd behavior. Scope the scrub to the trust surfaces: ACL
  evaluation, session/token auth, publish input handling (slugs, size,
  content types), page serving (CSP, path derivation), CLI token storage.
  The driver dispatches the scrub, triages verdicts, and packets fixes.

### phase-5-release-history: feat-only history, v0.1.0

- **Depends on:** phase-4-security-scrub
- **Packet scope:** driver-executed (git surgery + version bumps);
  worker packets only if mechanical edits are needed
  (`package.json` x4, `DELTA.md`, `.changeset/**` or direct bumps)
- **Acceptance:** local tag `archive/pre-0.1.0` marks the pre-rewrite tip
  BEFORE any rewrite; `main` is rebuilt into a small feat-only commit set
  (target shape: feat(core), feat(web), feat(cli), feat(harness),
  feat(ci/image), plus one docs commit for SPEC/BRIEFs/DELTA — Allen may
  amend the shape); tree identity holds — `git diff archive/pre-0.1.0 main`
  is empty except intended version bumps and doc-citation updates; all four
  packages bump 0.0.0 → 0.1.0; local tag `v0.1.0` on the new tip; DELTA.md
  historical-SHA citations updated to reference `archive/pre-0.1.0`; full
  harness green at the new tip; NOTHING is pushed — force-push of `main`
  and both tags are handoff items with exact commands recorded in
  `DELTA.md`.
- **Description:** Ratified this morning: launch is 0.1.0 on a clean
  feat-only history. The archive tag keeps every historical SHA cited in
  DELTA.md reachable. Author identity preserved (Big Boss). This phase runs
  last so every prior phase's commits fold into the clean set.

## Wrap

On `done`: refresh `DELTA.md` (dated entry; Boundary handoff updated with
the force-push + tag-push commands, GitHub repo-settings checklist, keychain
attended test, optional trivy/scout image scan, and the unchanged
OAuth → DNS → mirror → ESO → deploy → walkthrough chain); verify tree
committed and full harness green; absorb this file into `DELTA.md` /
`DEVIATIONS.md` / `docs/` as its predecessors prescribed, then delete it.
The wrap commit lands on top of the rewritten history as the one allowed
docs commit after `v0.1.0` — move the tag to the wrap commit if Allen's
shape prefers the tag at the true tip (record which was chosen).
