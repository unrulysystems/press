# Loop: Device-code CLI login — `feat/device-code-login`

Mission: drive this branch to **interior-green** so the only remaining steps
are the human's boundary calls (push, merge proposal, close #11/#17). Ship
`press login --device` so a CLI on a headless/remote host can mint a token
from a browser anywhere, and persist that token on non-macOS hosts via a
0600 XDG file store, without printing secrets or weakening loopback. Work
through the ADF loop (SPEC → PLAN → TDD → DEV → E2E). Unblock via the
ladder; the verifier — not confidence — decides when work is done.

## State (updated 2026-08-15 — rewrite each iteration; newest facts first)

- Branch `feat/device-code-login`, tree dirty with SPEC/BRIEF/LOOP, device
  flow, CLI `--device`, XDG file store, and e2e. Nothing pushed.
- Unit floors green (`nub run check`, `nub run test` 260 pass). Localnet
  `silo up main` healthy; dogfood `press login --device` → activate Approve
  → fresh `whoami` as `owner@send.it` with no token in stdout. Poll timer
  must stay referenced (unref let the process exit 0 before minting).
- E2E suite in flight. Close GitHub issues is a human boundary step.

## Decisions (append-only; do not re-litigate)

1. 2026-08-15 — `press login --device` is opt-in; loopback stays the default
   `press login`. A missing `open`/DISPLAY prints a hint only; the CLI never
   auto-switches. Why: loopback binds "browser and CLI share a machine";
   device flow is the weaker cross-device binding and must be explicit.
   ratified (human)
2. 2026-08-15 — last-resort 0600 XDG file store (`$XDG_CONFIG_HOME/press/tokens.json`,
   default `~/.config/press/tokens.json`) amends token persistence when no
   usable OS keychain exists. Resolution order: macOS Keychain → file store →
   `PRESS_TOKEN`. Why: device login on Linux is unusable if the minted token
   cannot persist; `Bun.secrets`/libsecret is absent on the headless hosts
   this feature is for. ratified (human)
3. 2026-08-15 — never print the minted API token (not on store failure, not
   in `--json`, not as guidance). Why: INV-4; page-password shown-once is the
   wrong analogue for a long-lived publish credential. ratified (human)
4. 2026-08-15 — do not replace the darwin Keychain FFI with `Bun.secrets` in
   this campaign. Why: the FFI already works; rewriting it is risk without
   benefit for the headless Linux path. ratified (human)
5. 2026-08-15 — not a general OAuth authorization server: no `client_id`, no
   `grant_type`, no third-party device clients. RFC 8628-shaped (device
   secret, user code, verification URI, poll errors pending/slow_down/deny/
   expiry) with press PKCE + B-1 consent. Activate lives at `/cli/activate`
   (reserved `cli` prefix; no new reserved slug). Why: press CLI is the only
   caller; OAuth ceremony would add surface without a client. ratified (human)

## Work plan (ADF per unit)

1. **SPEC** — amend REQ-AUTH-004 (second front door), REQ-AUTH-006 (file
   store), REQ-CLI-001 (`--device`), acceptance, non-goals, and BRIEF
   Decisions to match the ratified calls above. Establishes the contract.
   Defers implementation and tests.
2. **TDD server** — failing unit tests for device start, activate consent
   (CSRF, impersonation, GET-does-not-mint), poll/PKCE, deny, expiry,
   slow_down, user-code normalization, generic invalid errors, 8 KiB body
   cap. Establishes the red harness. Defers wiring and CLI.
3. **DEV server** — implement `cliDeviceFlow` handlers + `/cli/activate` and
   `/api/cli/device/{start,poll}` against those tests. Establishes the
   protocol. Defers CLI `--device` and the file store.
4. **TDD+DEV CLI** — `--device` (no loopback listener, print URI+user code
   only, poll, honor interval/slow_down) and last-resort 0600 XDG file store
   plus doctor `tokenSource: file`; darwin FFI and the test-build keychain
   seam stay intact. Establishes persistence. Defers e2e.
5. **E2E + dogfood** — real compiled `press login --device` + Playwright
   Approve on localnet; subsequent whoami; existing loopback suite still
   green; `nub run check` / `test` / `e2e`; live localnet dogfood. Then
   stop for the human's push/close-issues boundary.

## Verification floors

- `nub run check` → tsgo + oxlint + oxfmt green
- `nub run test` → unit/integration green, including device-grant and
  file-store tests that drive the shipped functions
- `nub run e2e` → Playwright acceptance green against localnet, including
  a compiled-`press --device` happy path and the existing loopback CLI test
- Review gate — harness first, briefed reviews: the driver and cooks own
  verification; do not outsource to a reviewer what a floor can decide.
  Every review carries its unit's contract — intended outcome, what to
  judge now, invariants, acceptance evidence, and work explicitly deferred
  to a later unit; declared deferred work is not a finding, current-unit
  regressions and contract violations are. Severity-floor semantics — floor
  `major`: findings at or above it block, a below-floor-only reject does
  not; max 3 review→fixup rounds per reviewed unit. A finding the harness
  should have caught earns a new floor, not just a patch.

## Unblocking ladder

Investigate (two focused passes) → doctrine (Decisions here, BRIEF/SPEC
Decisions, `doctrine.md` in the loop-brief skill, memory) → `rl consult`
with evidence + candidate approaches + spec excerpts → provisional decision
(dated entry above) → accumulate for the human (irreversible /
scope-changing / Boundary items only).

## In-session edit policy

The driver edits directly when the fix is finding-sized (≤ ~2 files,
mechanical, fully understood). After any in-session edit: run the owning
gates and commit conventionally — the edit lands in its unit's review
scope; the driver never self-approves. Larger or design-shaped work goes to a cook
packet. Never mix in-session edits with an in-flight worker on the same
files.

## Boundaries — NEVER

- Never push, open PRs, or merge — publish is the human's, per-artifact.
- Never touch live secrets or biometrics; never reroute around auth
  failures — surface and stop.
- Never real Google OAuth in tests/loops — localnet uses the seeded
  credential provider (REQ-AUTH-002).
- Never print, log, or argv a minted API token or page password.
- Never enable credential auth in production (INV-5).
- Never close GitHub issues #11/#17 from inside the loop.
- Never replace the darwin Keychain FFI with Bun.secrets.
- Never auto-select device flow.
- Never add a schema migration; reuse `verification`.

## Known pre-existing failures — do not chase (cited evidence only)

- AUDIT.md F-01..F-20 are resolved or deferred on the prior security
  ultra-audit (2026-08-11); do not reopen them unless this branch
  reintroduces the claim.

## Terminal states & budget

- **done:** LOOP.md present with the ratified Decisions; SPEC/BRIEF amended;
  `nub run check`, `nub run test`, and `nub run e2e` green; e2e covers
  compiled `press login --device` → activate Approve → whoami; localnet
  dogfood of that path succeeded; existing loopback CLI e2e still passes;
  no minted token printed. Then stop the loop, update State, and write the
  handoff for the human's boundary steps (push, issue close).
- **blocked:** numbered decision batch, each with evidence + a proposed
  answer; keep working independent items until only the batch remains.
- **budget:** hard cap `8` iterations for the campaign — or, earlier, three
  consecutive iterations without measurable movement on any checklist item
  → stop honestly with what was tried and why it cannot converge.
