---
'@press/cli': patch
---

Fix macOS keychain token storage so `press login` writes tokens without argv or TTY access and fails closed on read-back mismatch.
