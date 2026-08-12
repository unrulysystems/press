# @press/cli

## 0.4.0

### Minor Changes

- Standalone binaries are rebuilt from the security ultra-audit follow-up: the
  CLI authorize flow gains a same-origin consent step (server-owned pending
  record, approval page, loopback code minted only after a CSRF-protected POST),
  admin authority moves to config, the Better Auth admin plugin is dropped, and
  publish/ACL/input hardening lands (F-12..F-20, M-1..M-3). The CLI loopback
  contract itself is unchanged; the release carries the hardened server + CLI
  build for the mirrored web image.

## 0.3.1

### Patch Changes

- Make standalone release builds resolve workspace source directly so native CI builders do not
  depend on nondeterministic install-time workspace links.

## 0.3.0

### Minor Changes

- 8c7e55d: Ship standalone macOS arm64 and Linux x64 executables with exact version output,
  checksummed release archives, and compiled-binary acceptance coverage.

## 0.2.0

### Minor Changes

- 8f580d0: Add `press move` with permanent old-path redirects, explicit no-redirect moves,
  cross-collection ACL preservation, shared redirect-mode constants, and
  machine-readable source/destination output.

### Patch Changes

- Updated dependencies [8f580d0]
  - @press/core@0.2.0

## 0.1.1

### Patch Changes

- d60cced: Fix macOS keychain token storage so `press login` writes tokens without argv or TTY access and fails closed on read-back mismatch.
