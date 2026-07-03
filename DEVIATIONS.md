## 2026-07-03

- One production build currently fails with `ReferenceError: React$14 is not defined`
  during `one build`. Localnet and e2e therefore run the One dev server with the
  `Connection: close` API-context mitigation from commit `a793eeb`.
  Production-representative serving and the container image build are blocked on
  that upstream issue for Allen's attention.
