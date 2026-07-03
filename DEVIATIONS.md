## 2026-07-03

- One production build failure is resolved in phase-1. `nub run build:web`
  completes One's production client/server build and SSR prerender after an
  app-level Vite transform rewrites `@tamagui/use-event`'s React namespace
  import before Rolldown emits the broken `React$<N>` read. The rejected first
  green build used `NODE_ENV=development`, so it did not prove this floor; the
  build wrapper now defaults to production mode, disables credential auth, uses
  non-secret build placeholders for prerender-time production config parsing,
  and fails closed if `apps/web/dist/` contains `*.development.js` artifacts.
  Runtime production boot validation is unchanged. Localnet and e2e still run
  the One dev server in this phase; production-representative serving remains
  phase-2 work, not an active production-build blocker.
- Reproducibility floor — intermittent cold-start e2e failures: RETIRED
  2026-07-03. The dev-server harness could fail browser tests on the first
  run after cold state (~2/9 observed) with clean reruns passing. Phase-2
  routes Playwright through a built production artifact served by `one serve`
  under the same non-production seeded localnet runtime env, and fixed the
  one remaining snapshot-read race in `e2e/magazine.spec.ts` with retrying
  web-first assertions (identical expected values). Driver evidence in
  `DELTA.md`: 3 consecutive maximally-cold `nub run e2e` runs, 80/80 each.
  Assertions were not weakened. The e2e API-context `Connection: close`
  mitigation was removed 2026-07-03 after a prod-server keep-alive
  experiment: 3 consecutive maximally-cold `nub run e2e` runs passed 80/80
  with default keep-alive and no `EPIPE`/`ECONNRESET` (evidence in
  `DELTA.md`). The mitigation is deleted for good; nothing about it remains
  active.
