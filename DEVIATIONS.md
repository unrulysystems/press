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
- Reproducibility floor — intermittent cold-start e2e failures: warm runs are
  deterministic, but the first run after cold state can fail browser tests
  (~2/9 observed), with immediate reruns passing from the same clean slate. The
  nearest-feasible alternative is the dev-server `Connection: close` mitigation
  plus documented rerun discipline. Full determinism is blocked on production-
  representative serving until the One production build `React$14` upstream bug
  is resolved. Assertions are not weakened.
