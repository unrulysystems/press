# Rolldown drops referenced React namespace binding in SSR bundle

## Title

Rolldown drops a referenced namespace import binding, producing `React$N is not defined`.

## Affected Versions

- Project-tested baseline: `vite@8.0.3`, which bundled `rolldown@1.0.0-rc.12`.
- Latest tested by this project: `vite@8.1.3` on 2026-07-03.
- Related packages in the repro: `@tamagui/use-event@2.3.1`, `@tamagui/vite-plugin@2.3.1`, `react@19.2.0`, `react-dom@19.2.0`, `one@1.20.2`.

`one@1.20.2` declares `vite` as dependency range `^8.0.13`; `vite@8.1.3` is inside that range.

## Minimal Repro

1. Create a Vite SSR build that bundles `@tamagui/use-event/dist/esm/useGet.mjs` through Rolldown, with `ssr.noExternal = true`.
2. Import Tamagui components so the server bundle includes `@tamagui/use-event`.
3. Build a production SSR artifact with `vite@8.1.3`.
4. Import the built server entry in Node.

The source module contains a React namespace import pattern:

```js
import * as React from 'react'
const useIsomorphicInsertionEffect = React.useInsertionEffect || React.useLayoutEffect
```

## Expected

The generated SSR bundle keeps or rewrites the namespace import binding so every `React$N.*` reference is declared before use.

## Actual

The generated SSR bundle contains a `React$15` read with no corresponding declaration, and importing the server bundle fails.

Evidence from the failed build with the local workaround removed:

- `apps/web/vite.config.ts:10` defines the pre-transform workaround.
- `apps/web/vite.config.ts:52` registers the workaround in the passing build.
- `apps/web/dist/server/_virtual_one-entry.js:7660` contained `React$15.useInsertionEffect || React$15.useLayoutEffect;` in the failing build.

Failure:

```text
ReferenceError: React$15 is not defined
    at file:///Users/allen/0xbigboss/press/apps/web/dist/server/_virtual_one-entry.js:7660:2
```

## Local Workaround

A Vite `enforce: 'pre'` transform rewrites `@tamagui/use-event/dist/esm/useGet.mjs` from a React namespace import to named React imports before the production SSR bundle is emitted.
