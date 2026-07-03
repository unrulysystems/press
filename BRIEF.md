# press — BRIEF

Law doc for the press product surface (server + CLI + repo), present-tense, no
narrated history — git is the changelog. Amend Decisions and Boundary only with
Allen's confirmation; log the rationale. Dated working memory lives in
`DELTA.md` / `DEVIATIONS.md` beside this file. The web UI's design law is
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

## Floors (gate, not ceiling)

| Floor                                                    | Measured by                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types/lint/format green                                  | `nub run check` (tsgo -b, oxlint, oxfmt --check)                                                                                                              |
| ACL matrix + slug grammar + password hashing unit-tested | `nub run test` — includes exhaustive table test over REQ-ACL-001 via the pure ACL function                                                                    |
| Full e2e acceptance list green                           | `nub run e2e` against localnet (`nub run localnet` boots Postgres + server + seeded users; suite = SPEC.md acceptance criteria, Playwright + real CLI binary) |
| Sandbox CSP on every served page                         | e2e asserts REQ-SRV-002 headers on every `/p/` 200 in the run                                                                                                 |
| Publish path exercised end-to-end                        | e2e drives the actual `press` binary (spawned process), not raw HTTP shortcuts                                                                                |
| Boot fail-closed                                         | e2e asserts prod+credential-auth boot refusal (INV-5) and missing-config abort (REQ-CFG-002)                                                                  |

## Oracle

- **Objective floors:** the e2e suite runs the real stack — One server, real
  Postgres, seeded credential users, the compiled CLI — and asserts externally
  observable HTTP/process behavior. The maker cannot grade its own work because
  assertions bind to SPEC REQ IDs fixed before implementation (TDD: tests land
  red first), and the suite runs in CI on every push.
- **Fresh-context review:** each loop phase ends with an independent reviewer
  (e.g. `/code-review` or an rl review gate) that did not author the diff.
- **Final gate (human, attended):** one manual walkthrough on a real deploy with
  real Google sign-in before any instance ships — the live system check the
  localnet proxy cannot replace.
- **Telemetry (post-ship):** audit table + server logs on the instance confirm
  publishes/reads behave; instance monitoring rides the operator's stack.

## Never

- A secret value (OAuth secret, session secret, API token, page password) in
  argv, logs, committed files, or chat output.
- A mutation authorized by a session cookie (INV-1).
- A `/p/` response missing the exact sandbox CSP (INV-2).
- A served path derived from raw URL input instead of DB-validated slugs
  (INV-3).
- Credential auth enabled in production (INV-5).
- Weakening a floor or assertion to make a loop pass — infeasible items get the
  nearest-feasible alternative plus a `DEVIATIONS.md` entry.
- Pushing, publishing packages/images, or deploying from inside a loop.

## Decisions (ratified by Allen, 2026-07-02 — do not re-ask)

- Generic multi-report product under **unrulysystems**; instance #1 is Send's
  `reports.send.it`. All org-isms are env config (REQ-CFG-001).
- **Web-only.** No native targets, no Zero sync, no SST/hot-updater grafts.
- Stack: **One (OneStack) + Tamagui + Better Auth + Drizzle + Postgres**, built
  on the typescript-template skeleton; graft patterns from Takeout v2
  (`~/0xbigboss/tamagui/takeout2`) — copy liberally where useful, don't fork it.
- **Postgres from day one** (not SQLite). Blobs are flat files on disk.
- oauth2-proxy is **out**; the app owns login, sessions, ACLs, Basic auth,
  public bypass.
- CLI auth = **press-issued revocable API token** via browser-loopback against
  press's own Better Auth; Google credentials never ship in the CLI. Token in
  the macOS keychain; `PRESS_TOKEN` env for CI/non-mac agents. Agents publish
  silently (no per-publish human confirm) — an org-gated internal surface is
  closer to a shared drive than a public deploy.
- Visibility: `default` (org domains) / `public` / `password` / `private`
  (email allowlist, externals allowed); per-page with collection default.
  Page passwords are server-generated, shown once, argon2-hashed.
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
- Priority policy: **security > correctness > design > ergonomics > latency.**
  A security concern can force a redesign; latency cannot.

## Boundary (Allen's alone)

- Creating the GitHub repo / pushing anywhere; publishing images or packages.
- Creating the Google OAuth client; DNS; any deploy; any live secret.
- The attended real-Google final-gate walkthrough.
- Amending SPEC requirements, this brief's Decisions/Boundary, or the design
  brief's taste direction.
- Loops commit locally and stop at the boundary; `blocked` terminates with
  accumulated questions, never a mid-loop freeze on one.
