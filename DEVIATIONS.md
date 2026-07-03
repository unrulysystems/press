## 2026-07-03

- One production build currently fails with `ReferenceError: React$14 is not defined`
  during `one build`. Localnet and e2e therefore run the One dev server with the
  `Connection: close` API-context mitigation from commit `a793eeb`.
  Production-representative serving and the container image build are blocked on
  that upstream issue for Allen's attention.
- Reproducibility floor — intermittent cold-start e2e failures: warm runs are
  deterministic, but the first run after cold state can fail browser tests
  (~2/9 observed), with immediate reruns passing from the same clean slate. The
  nearest-feasible alternative is the dev-server `Connection: close` mitigation
  plus documented rerun discipline. Full determinism is blocked on production-
  representative serving until the One production build `React$14` upstream bug
  is resolved. Assertions are not weakened.
