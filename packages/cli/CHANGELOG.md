# @press/cli

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
