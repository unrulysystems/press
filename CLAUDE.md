# press

Self-hosted, CLI-published, identity-gated HTML report publishing. Owned by
unrulysystems (Allen / 0xbigboss). Built from typescript-template.

## Document map (read before working)

- `VISION.md` — what press is and why.
- `SPEC.md` — the contract: REQ-\*, invariants, acceptance criteria. Ratified;
  amendments are Allen's.
- `BRIEF.md` — engineering quality law: floors, oracle, Never list, ratified
  Decisions (do not re-ask them), Boundary.
- `apps/web/BRIEF.md` — design/taste law for the web surface (magazine bar,
  blind screenshot oracle).
- `AUDIT.md` — the security audit ledger (tooling-owned).
- `docs/ops.md` — backup/restore and archive-purge runbook.
- `README.md` — development session and deployment (boundary) steps.

## Commands

- `nub install` — install workspace deps.
- `nub run check` — tsgo typecheck + oxlint + oxfmt (must stay green).
- `nub run test` — Bun unit/integration tests.
- `nub run localnet` — boot the silo/Tilt `main` localnet with Postgres,
  migrations, seed data, and the One dev server.
- `nub run e2e` — Playwright acceptance suite against localnet only.
- `bun scripts/capture-oracle-shots.ts` — capture blind-oracle screenshots into
  `artifacts/oracle/`.

## Hard rules

- Never real Google OAuth in tests/loops — localnet uses the seeded credential
  provider (see REQ-AUTH-002).
- Secrets never in argv, logs, or the repo; page passwords exist only in the
  one-time publish response.
- Push, package/image publish, OAuth client creation, DNS, deploys: Allen only.
- Takeout v2 (`~/0xbigboss/tamagui/takeout2`) is a pattern source to copy from,
  never a runtime dependency.
