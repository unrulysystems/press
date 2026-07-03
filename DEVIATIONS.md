# press — DEVIATIONS

- 2026-07-03 — Real macOS Keychain final-gate: autonomous e2e verifies CLI token
  storage through a PATH-shadowed `security` stub that accepts the token on
  stdin and persists to a temp file. The real attended macOS Keychain walkthrough
  remains Allen's boundary because `security -w <token>` places secrets in argv,
  which press never allows inside the loop.
