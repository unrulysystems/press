# press — DELTA

## 2026-07-03

Status: all 8 loop phases are complete. The full harness is green from a clean
localnet boot, and the magazine screenshot oracle reached quorum in round 3
(2-of-3 judges passed). Judge G's dissent on static link affordance for entry
titles remains a taste follow-up for Allen.

Known gaps and follow-ups:

- One production build is green as of phase-1. The chosen intervention is
  app-level config: `apps/web/vite.config.ts` adds a focused pre-transform for
  `@tamagui/use-event/dist/esm/useGet.mjs` that rewrites the React namespace
  import to named hook imports before One's production SSR bundle reaches the
  Vite 8 / Rolldown deconfliction bug. `apps/web/src/buildWeb.ts` wraps
  `one build --platform=web` with deterministic local build-time env in
  production mode so One's prerender import can evaluate server config without
  live OAuth or secrets; runtime boot validation remains unchanged.
- Attempt-1 review reject: the first green `nub run build:web` was not valid
  production evidence because `apps/web/src/buildWeb.ts` defaulted
  `NODE_ENV=development` and enabled credential auth, producing React
  development artifacts. Production-mode repros then proved INV-5 was still
  intact: `NODE_ENV=production nub run build:web` refused credential auth, and
  `NODE_ENV=production PRESS_ENABLE_CREDENTIAL_AUTH=0 nub run build:web`
  refused missing Google OAuth client values during One's prerender-time
  config import. The wrapper now defaults `NODE_ENV=production`,
  `PRESS_ENABLE_CREDENTIAL_AUTH=0`, and uses clearly labeled
  `build-placeholder` OAuth values plus a build-only Better Auth placeholder.
  These placeholders are not secrets and exist only so the build machine can
  pass production config parsing; runtime production boot validation is
  unchanged and still refuses bad env at serve time.
- Rejected config probes before the final app-level transform: adding
  `@tamagui/use-event` to `ssr.external` bypassed the missing `React$15`
  binding but failed prerender with
  `SyntaxError: Export '_disableMediaTouch' is not defined in module`;
  `resolve.dedupe: ['react', 'react-dom']` had no effect and returned the same
  `ReferenceError: React$15 is not defined`; removing app-level
  `ssr.noExternal` also returned the same `React$15` failure. A direct
  installed-package rewrite of `@tamagui/use-event` proved the named-import
  change moved the build past the Rolldown failure, but a committed package
  patch was rejected because `nub patch` could not locate the app-local package
  in the current hoisted install layout and manual `patchedDependencies`
  metadata did not apply on `nub install`.
- Root cause, production build failure: the 2026-07-03 `nub run build:web`
  repro emits the missing read in `apps/web/dist/server/_virtual_one-entry.js`
  at `7660:2`, inside the `@tamagui/use-event/dist/esm/useGet.mjs` region
  (`apps/web/dist/server/_virtual_one-entry.js:7657-7661`). The route import
  that triggers evaluation is `/app/c/[collection]+ssr.tsx` to
  `./assets/_collection__ssr-DogSemhY.js`
  (`apps/web/dist/server/_virtual_one-entry.js:31643`), and that page chunk
  imports `useLoader` from `../_virtual_one-entry.js`
  (`apps/web/dist/server/assets/_collection__ssr-DogSemhY.js:1`).
  `apps/web/dist/server/assets/react-dom-B39j4I0W.js:9-15` is the shared
  `__esmMin` wrapper that rethrows the failed initializer; its React export is
  `require_react`, not a `React$15` binding
  (`apps/web/dist/server/assets/react-dom-B39j4I0W.js:405-406`,
  `apps/web/dist/server/assets/react-dom-B39j4I0W.js:564`).
- The `React$15` binding was supposed to be the namespace import for
  `import * as React from "react"` in `@tamagui/use-event`:
  the package source reads `React.useInsertionEffect || React.useLayoutEffect`
  (`apps/web/node_modules/@tamagui/use-event/dist/esm/useGet.mjs:1-2`), and
  Vite's SSR dependency prebundle lowers that source to an explicit
  `import_react` declaration plus `__toESM(require_react(), 1)`
  (`apps/web/node_modules/.vite/deps_ssr/@tamagui_use-event.js:11-15`).
  The final production SSR chunk keeps the deconflicted read as
  `React$15.useInsertionEffect || React$15.useLayoutEffect` but does not emit
  the matching declaration in the surrounding initializer
  (`apps/web/dist/server/_virtual_one-entry.js:7657-7666`); the neighboring
  React namespace imports are emitted as `import_react$117` before it and
  `import_react$116` after it
  (`apps/web/dist/server/_virtual_one-entry.js:7599-7603`,
  `apps/web/dist/server/_virtual_one-entry.js:8333-8336`).
- Ownership evidence points to the Vite 8 / Rolldown production SSR bundling
  step as exercised by One, not to app route code. One creates the virtual
  entry with `import.meta.glob(...)` routes and no React namespace binding
  (`apps/web/node_modules/one/dist/esm/vite/plugins/virtualEntryPlugin.mjs:96-121`),
  then imports each built server route during prerender
  (`apps/web/node_modules/one/dist/esm/cli/build.mjs:729-737`). The app config
  only wires Tamagui, One, aliases, and `ssr.noExternal: true`
  (`apps/web/vite.config.ts:1-35`). Tamagui's Vite transform is scoped to
  `.tsx` files (`apps/web/node_modules/@tamagui/vite-plugin/dist/esm/plugin.mjs:286-300`),
  while the failed source is `.mjs`
  (`apps/web/node_modules/@tamagui/use-event/dist/esm/useGet.mjs:1-2`).
  One's server build runs through Vite with `build.ssr: true`,
  `rolldownOptions`, and strict entry signatures
  (`apps/web/node_modules/one/dist/esm/cli/build.mjs:403-428`), so the dropped
  declaration is in Rollup/Rolldown namespace-import deconfliction/interop for
  the SSR chunk produced under One's build pipeline.
- Phase-1 fix directions, ranked by the allowed intervention order in the
  loop plan (`loop.md:41-46`, `loop.md:75-87`): first try app-level Vite/One
  config because the app already controls `ssr.external`, `ssr.noExternal`,
  aliases, and plugin order (`apps/web/vite.config.ts:7-35`), and the
  supporting evidence is that prebundled SSR output preserves the binding
  (`apps/web/node_modules/.vite/deps_ssr/@tamagui_use-event.js:11-15`) while
  the production final chunk does not
  (`apps/web/dist/server/_virtual_one-entry.js:7657-7666`). If config cannot
  force a correct SSR boundary, use a committed `bun patch` against One/Vite
  integration because One owns the production prerender import and SSR build
  configuration (`apps/web/node_modules/one/dist/esm/cli/build.mjs:403-428`,
  `apps/web/node_modules/one/dist/esm/cli/build.mjs:729-737`). Treat a One
  version change as third because the installed versions are pinned in
  `apps/web/package.json:21-27`, and the loop plan allows version changes only
  after config and patch paths (`loop.md:41-46`).
- The `build:web` gate is green after phase-1 in production mode:
  `nub run build:web` completes `one build --platform=web`,
  imports/prerenders `/`, `/login`, and `/c/:collection`, emits
  `version.json`, passes One's client bundle security scan, and the wrapper's
  fail-closed scan finds no `*.development.js` artifacts in `apps/web/dist/`.
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
5. Finish production-representative serving and the local container image
   phases, then build and mirror the image to `0xsend/press` with its
   manifests.
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
