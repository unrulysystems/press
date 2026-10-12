---
'@press/cli': patch
---

Fix the macOS arm64 release binary signature. Release builds use Bun 1.4.3, and the release workflow fails the tag unless the packaged artifact passes `codesign --verify --strict` and `press --version`.
