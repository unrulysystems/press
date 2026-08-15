# press — BRIEF

Law doc for the press product surface (server + CLI + repo), present-tense, no
narrated history — git is the changelog. Amend Decisions and Boundary only with
Allen's confirmation; log the rationale. The web UI's design law is
`apps/web/BRIEF.md`.

## Bar

A fresh clone boots localnet in one command and passes the full harness; a human
or agent can publish an HTML page in one CLI command and share it under exactly
the intended visibility — with zero plaintext secrets anywhere and no way for a
published page to attack its readers.

## Dimensions

- **ACL correctness** — every read/mutation lands exactly per REQ-ACL-001/005.
- **Auth integrity** — sessions, tokens, and the localnet/prod provider split
  behave per SPEC; nothing secret leaks.
- **Content isolation** — published HTML cannot read other pages or act as its
  viewer.
- **Publish ergonomics** — the CLI path is short, scriptable, and honest about
  errors.
- **Auditability** — every mutation is attributable after the fact.
- **Reproducibility** — localnet and the harness are deterministic; no network
  or human dependency inside the loop.
- **Distribution integrity** — supported release artifacts are self-contained,
  version-identifiable, checksummed, and exercised as the real CLI surface.

## Floors (gate, not ceiling)

| Floor                                                    | Measured by                                                                                                                                                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types/lint/format green                                  | `nub run check` (tsgo -b, oxlint, oxfmt --check)                                                                                                                                               |
| ACL matrix + slug grammar + password hashing unit-tested | `nub run test` — includes exhaustive table test over REQ-ACL-001 via the pure ACL function                                                                                                     |
| Full e2e acceptance list green                           | `nub run e2e` against localnet (`nub run localnet` boots Postgres + server + seeded users; suite = SPEC.md acceptance criteria, Playwright + real CLI binary)                                  |
| Sandbox CSP on served report pages                       | e2e asserts REQ-SRV-002 headers on every `/p/` 200 serving report content; the REQ-SRV-004 entry page instead carries its strict form-capable CSP (no scripts, no report body)                 |
| Publish path exercised end-to-end                        | e2e drives the actual `press` binary (spawned process), not raw HTTP shortcuts                                                                                                                 |
| Packaged CLI is self-contained                           | binary smoke runs `--version` and `doctor --json` from outside the checkout with Bun absent from `PATH`; archive rehearsal asserts one root `press` executable plus matching SHA-256 checksums |
| Release platforms are truthful                           | native macOS arm64 and Linux x64 release jobs assert the executable architecture and run the packaged-binary smoke before upload                                                               |
| Boot fail-closed                                         | e2e asserts prod+credential-auth boot refusal (INV-5) and missing-config abort (REQ-CFG-002)                                                                                                   |

## Oracle

- **Objective floors:** the e2e suite runs the real stack — One server, real
  Postgres, seeded credential users, the compiled CLI — and asserts externally
  observable HTTP/process behavior. The maker cannot grade its own work because
  assertions bind to SPEC REQ IDs fixed before implementation (TDD: tests land
  red first), and the suite runs in CI on every push.
- **Fresh-context review:** each loop phase ends with an independent reviewer
  (e.g. `/code-review` or an rl review gate) that did not author the diff.
- **Harness limits:** reviewer/worker sandboxes cannot run Docker/Chromium
  executable proofs; the driver runs them in a real environment and the review
  gate accepts that evidence. The Google sign-in click-path (prod-only
  provider) is covered only by the attended real-Google final gate — localnet
  is credential-only (REQ-AUTH-002).
- **Final gate (human, attended):** one manual walkthrough on a real deploy with
  real Google sign-in before any instance ships — the live system check the
  localnet proxy cannot replace.
- **Telemetry (post-ship):** audit table + server logs on the instance confirm
  publishes/reads behave; instance monitoring rides the operator's stack.

## Never

- A secret value (OAuth secret, session secret, API token, page password) in
  argv, logs, committed files, or chat output.
- A mutation authorized by a session cookie (INV-1).
- A `/p/` report response missing the exact sandbox CSP, or the REQ-SRV-004 entry
  page carrying a report-executing CSP (INV-2).
- A served path derived from raw URL input instead of DB-validated slugs
  (INV-3).
- Credential auth enabled in production (INV-5).
- Weakening a floor or assertion to make a loop pass — infeasible items get the
  nearest-feasible alternative plus a dated BRIEF Decisions entry.
- Pushing, publishing packages/images, or deploying from inside a loop.
- Publishing tags or GitHub Release assets from inside a loop.

## Decisions (ratified by Allen, 2026-07-02 — do not re-ask)

- Generic multi-report product under **unrulysystems**. All org-isms are env
  config (REQ-CFG-001); each deployment is an instance with its own identity
  provider client, allowed domains, hostname, and storage.
- **Web-only.** No native targets, no Zero sync, no SST/hot-updater grafts.
- Stack: **One (OneStack) + Tamagui + Better Auth + Drizzle + Postgres**, built
  on the typescript-template skeleton; graft patterns from a reference
  monorepo (Better Auth wiring, Drizzle setup, upload route shape) — copy
  liberally where useful, don't fork it.
- **Postgres from day one** (not SQLite). Blobs are flat files on disk.
- oauth2-proxy is **out**; the app owns login, sessions, ACLs, Basic auth,
  public bypass.
- CLI auth = **press-issued revocable API token** via browser-loopback against
  press's own Better Auth (default), or opt-in device-code login (`press login
--device`) when the browser is not on the CLI host; Google credentials never
  ship in the CLI. Token in the macOS keychain; last-resort 0600 XDG file store
  when no usable OS keychain exists; `PRESS_TOKEN` env for CI/agents. Agents
  publish silently (no per-publish human confirm) — an org-gated internal
  surface is closer to a shared drive than a public deploy. (Device door +
  file store ratified 2026-08-15.)
- Visibility: `default` (org domains) / `public` / `password` / `private`
  (email allowlist, externals allowed); per-page with collection default.
  Page passwords are server-generated by default; a publisher may supply a custom
  one (≥ 8 chars) via hidden prompt / `PRESS_PAGE_PASSWORD` / stdin — never argv
  (INV-4). Either way argon2-hashed, shown once (ratified 2026-07-04).
  Collection `defaultVisibility` ranges over `default | public | private`
  only — `password` is page-explicit, never a collection default, because its
  server-generated per-page material cannot be supplied by inheritance
  (ratified 2026-07-03).
- Ownership: first publisher owns the collection; only owners publish into
  their collections; admins may moderate (unpublish) but never publish-as.
- Serving prefix **`/p/`** for all visibilities (prefix never encodes
  visibility). Report isolation via CSP `sandbox allow-scripts allow-popups` —
  no "trust this author" interstitials (warning fatigue between trusted
  colleagues); trust signal = attribution on the feed + audit log.
- **Localnet e2e is a hard requirement**; real Google OAuth is never in the
  loop — credential provider with seeded users is the deterministic stand-in
  (same session/ACL code paths), real-Google is the attended final gate.
- Overwrite allowed, no version history in v1; unpublish = soft-delete;
  ~25 MiB upload cap; Better Auth rate limiting on; CI = GitHub Actions
  running check + unit + localnet e2e.
- Page moves preserve the page's content, metadata, original publication time,
  and effective ACL while changing its canonical `/p/` path. `press move`
  defaults to a public permanent redirect from the old path; `--redirect none`
  leaves 404. Redirects expose only the current canonical path, never content,
  and always defer content authorization to the destination. Prior aliases
  follow the stable page identity through repeated moves; live pages and other
  pages' redirects are hard destination conflicts, archived destinations are
  reclaimable, and moving back consumes the same-page alias. Temporary and
  standalone redirect management are out of v1 (ratified 2026-07-09).
- The CLI ships as standalone GitHub Release binaries for macOS arm64 and Linux
  x64, with one root `press` executable per archive, SHA-256 checksums, and
  `press --version` equal to the semver release. Installation on operator hosts
  is owned by a single managed fleet tool; no Homebrew, npm-global, bun-global,
  checkout shim, or ad-hoc
  `~/.local/bin` owner runs in parallel. Source-package release capability
  remains available (ratified 2026-07-12).
- The release channel is authenticated GitHub Releases in this repository,
  with no separate release-only mirror. Hosts may obtain download authorization
  from the operator's existing GitHub CLI session without storing a token in
  the repository (ratified 2026-07-13).
- Reader-facing gates are magazine-grade, never dead-ends (ratified 2026-07-04,
  from the dogfood bug bash):
  - `password` pages serve a **branded HTML password-entry page** to browsers
    (no OS Basic-Auth dialog, no body leak); Basic auth stays the programmatic
    channel only (REQ-ACL-002 / REQ-SRV-004).
  - `press publish` output is **honest about sharing**: password pages print
    reader guidance, private pages echo the resolved allowlist; `--json` carries
    `allow` (REQ-PUB-004 / REQ-CLI-004).
  - `/login` always presents the enabled provider's sign-in affordance and tells
    a reader who can't sign in what to do — never copy-only (REQ-AUTH-008).

### 2026-08-15 — device-code login + last-resort file store

- `press login --device` is **opt-in**. Default `press login` stays
  loopback. A missing `open`/DISPLAY prints a hint only; the CLI never
  auto-switches. Device flow is the weaker cross-device binding and must
  be explicit.
- Token persistence when no usable OS keychain exists is a **host-scoped
  0600 file** at `$XDG_CONFIG_HOME/press/tokens.json` (default
  `~/.config/press/tokens.json`; directory 0700). Resolution: macOS
  Keychain → file store → `PRESS_TOKEN`. The CLI never prints a minted
  token. `PRESS_E2E_KEYCHAIN_FILE` remains test-build-only (F-16).
- Not a general OAuth authorization server: no `client_id`, no
  `grant_type`, no third-party device clients. Activate lives at
  `/cli/activate`. The darwin Keychain FFI is not rewritten to
  `Bun.secrets` in this campaign.

### 2026-08-11 — security ultra-audit follow-up (F-12..F-20)

- Republish-after-unpublish is a **fresh publish** (F-18): a PUT on an
  `archivedAt` row with no explicit visibility/allow/password options starts
  neutral like a first publish (`visibility=null`, `allowlist=[]`, password
  generated and returned once only when requested); overwrite of a LIVE page
  keeps prior settings. (Ratified at review gate 1; final Allen ratification
  at the boundary.)
- Unlock cookies bind to the page's current password hash (F-15/19): the
  cookie signature covers the row's `passwordHash`, so a reroll or
  overwrite-publish invalidates outstanding cookies immediately, with no
  schema change.
- Small dedicated caps for anonymous bodies (M-3): `/api/cli/exchange` JSON
  and the password-gate POST are byte-capped (413 before buffering, stream
  cancel) far below `PRESS_MAX_UPLOAD_BYTES`; the publish upload cap is
  unchanged.
- The keychain test seam is test-build-only (F-16): `PRESS_E2E_KEYCHAIN_FILE`
  is honored only in compiled test/e2e binaries, never a release build.
- CLI authorize has a **same-origin consent step** (B-1 A, Allen): server-owned
  pending-login record, same-origin approval page, loopback code minted only
  after a CSRF-protected POST presenting a server-generated consent token
  (F-12/17; REQ-AUTH-004 amended).
- Config is the **admin source of truth** (B-2 A, Allen): the role is derived
  at every sign-in (promote and demote) and resolved from
  `PRESS_ADMIN_EMAILS` at every authorization use; the stored role column is a
  cache (F-13; REQ-AUTH-007 amended).
- The Better Auth `admin()` plugin is **removed** (B-3 A, Allen): press
  moderation is read-all + unpublish via `decideAcl` (F-14).
- Session and OAuth tokens at rest (F-04 residual, deferred 2026-07-04):
  Better Auth session bearer tokens remain unhashed at rest by design —
  hashing them or dropping the `account` token columns overrides Better Auth's
  adapter schema for marginal benefit; the DB and its dumps are treated as
  secret-bearing (`docs/ops.md`). Allen's call if that tradeoff changes.
- Priority policy: **security > correctness > design > ergonomics > latency.**
  A security concern can force a redesign; latency cannot.

## Boundary (Allen's alone)

- Creating or changing visibility of a GitHub repo; pushing anywhere; creating
  tags or GitHub Releases; publishing images, packages, or release assets.
- Deploying the resulting configuration to instance hosts.
- Creating the Google OAuth client; DNS; any deploy; any live secret.
- The attended real-Google final-gate walkthrough.
- Amending SPEC requirements, this brief's Decisions/Boundary, or the design
  brief's taste direction.
- Loops commit locally and stop at the boundary; `blocked` terminates with
  accumulated questions, never a mid-loop freeze on one.
