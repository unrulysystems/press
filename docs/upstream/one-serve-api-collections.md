# one serve catch-all handles bare /api/collections before app route

## Title

`one serve` routes bare `/api/collections` to the dynamic catch-all path instead of the collection index route.

## Affected Versions

- Project-tested baseline: `one@1.19.4`.
- Latest tested by this project: `one@1.20.2` on 2026-07-03.
- Repro server: `one serve --host 127.0.0.1 --port 4174`.
- Vite in latest test: `vite@8.1.3`.

## Minimal Repro

1. Create a One app with an API route module that exports handlers for:
   - `GET /api/collections`
   - `GET /api/collections/:collection/pages`
   - `PATCH /api/collections/:collection`
2. In the dynamic route handler, parse `:collection` as a non-empty slug.
3. Build and serve the app with `one serve`.
4. Request the bare collection index path:

```sh
curl -i http://127.0.0.1:4174/api/collections
```

## Expected

The bare `/api/collections` route reaches the app's collection index handler. In this project, an unauthenticated request should fail inside that handler with:

```text
HTTP/1.1 401 Unauthorized
{"error":"valid bearer token required"}
```

## Actual

Without app-level bare-path delegation, `one serve` lets the dynamic collection path parse an empty slug. The response is a catch-all slug validation failure:

```text
HTTP/1.1 400 Bad Request
{"error":"collection slug: must match ^[a-z0-9][a-z0-9-]{0,62}$"}
```

Evidence:

- `apps/web/src/publish/routes.ts:90` parses dynamic collection paths by slicing `/api/collections/`.
- `apps/web/src/publish/routes.ts:106` identifies the bare `/api/collections` and `/api/collections/` paths.
- `apps/web/src/publish/routes.ts:819` delegates those bare paths to the collection index endpoint before dynamic slug parsing.

## Local Workaround

The app-level handler checks for `GET /api/collections` and `GET /api/collections/` before calling the dynamic collection path parser.
