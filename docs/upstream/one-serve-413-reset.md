# one serve can reset oversized upload sockets before readable 413 response

## Title

`one serve` can reset the client socket when an upload handler returns 413 before draining the request body.

## Affected Versions

- Project-tested baseline: `one@1.19.4`.
- Latest tested by this project: `one@1.20.2` on 2026-07-03.
- Repro server: `one serve --host 127.0.0.1 --port 4174`.
- Vite in latest test: `vite@8.1.3`.

## Minimal Repro

1. Create a One API route that accepts `PUT /api/pages/:collection/:file`.
2. In the handler, reject requests with `Content-Length` greater than an upload cap and immediately return a 413 JSON response without consuming the body stream.
3. Build and serve with `one serve`.
4. Upload a body larger than the cap with curl:

```sh
python3 - <<'PY'
from pathlib import Path
Path('/tmp/too-large.html').write_bytes(b'x' * (1024 * 1024 + 1))
PY
curl -i -X PUT \
  -H 'Content-Type: text/html' \
  --data-binary @/tmp/too-large.html \
  http://127.0.0.1:4174/api/pages/demo/too-large.html
```

## Expected

The client receives a readable 413 response:

```text
HTTP/1.1 413 Payload Too Large
{"error":"request body exceeds PRESS_MAX_UPLOAD_BYTES"}
```

The server should not reset the socket solely because the handler rejects the request before consuming the complete request body.

## Actual

In this project, the handler needed to drain a bounded body prefix before returning 413 to avoid client-side socket reset behavior under `one serve`. The bounded drain is retained as correct server hygiene, but the framework-level behavior is still worth investigating because a normal early 413 should be readable by clients.

Evidence:

- `apps/web/src/publish/routes.ts:263` enters the oversized-body rejection helper.
- `apps/web/src/publish/routes.ts:264` documents the observed `one serve` socket reset behavior.
- `apps/web/src/publish/routes.ts:267` drains `PRESS_MAX_UPLOAD_BYTES + 1` bytes before throwing the 413.
- `apps/web/src/publish/routes.ts:268` throws the readable 413 after the bounded drain.

## Local Workaround

When `Content-Length` exceeds the configured upload cap, the handler consumes only the smallest contract-relevant prefix (`maxUploadBytes + 1`) and then cancels the stream before returning the 413 JSON response.
