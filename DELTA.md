# press — DELTA

## 2026-07-03

Status: all 8 loop phases are complete. The full harness is green from a clean
localnet boot, and the magazine screenshot oracle reached quorum in round 3
(2-of-3 judges passed). Judge G's dissent on static link affordance for entry
titles remains a taste follow-up for Allen.

Known gaps and follow-ups:

- One production build fails with `ReferenceError: React$14 is not defined`.
  This blocks production-representative serving and the container image until
  the upstream issue is resolved; `DEVIATIONS.md` carries the active deviation.
- The e2e suite runs the Vite dev server with `Connection: close` API contexts
  as the determinism mitigation.
- The first full `nub run e2e` after a cold state can intermittently fail
  browser assertions during Vite on-demand compilation. The current evidence is
  ~2 failing first-runs across ~9 full runs, always after substantial state
  changes such as new code landing or `docker compose -p press-localnet down -v`;
  the immediate rerun from the same clean slate passes 80/80. Watch this in CI.
  The root fix is production-representative serving, currently blocked on the
  One production build bug.
- Real macOS keychain interaction is stub-verified only and remains an attended
  final gate.
- GitHub Actions has not executed because the repo has not been pushed.

Boundary handoff for Allen:

1. Push the repo to `unrulysystems/press`.
2. Confirm GitHub Actions is green.
3. Create the Google OAuth client.
4. Configure DNS for instance #1 at `reports.send.it`.
5. Resolve the One production build bug, then build and mirror the image to
   `0xsend/press` with its manifests.
6. Provision ESO secrets.
7. Deploy.
8. Run the attended real-Google final-gate walkthrough required by `BRIEF.md`.

## 2026-07-02 — password as collection defaultVisibility rejected

Pending Allen's ratification: `password` is rejected as a collection
`defaultVisibility`. The SPEC Domain model types the four-value visibility union
on `Page.visibility`; `Collection.defaultVisibility` is not explicitly typed.
Password visibility requires per-page server-generated material: the one-time
password response and stored argon2 hash from REQ-PUB-005. Collection-level
inheritance cannot supply that material, including retroactively when patching a
collection default would flip existing unset pages into password-with-no-hash.
The coherent fail-closed reading is that collection defaults range over
`default | public | private`, while `password` is page-explicit only.
