import type { Endpoint } from 'one'

// Liveness/readiness probe target for the Kubernetes Deployment (httpGet on `/health`,
// see press-deploy DEPLOYMENT.spec.md). Intentionally identical to `/healthz` — that path
// is already wired into the local harness (e2e, smoke:image, backup drill, scripts), so it
// stays; `/health` is the conventional name the cluster probe points at. Both return 200
// "ok\n" the moment the HTTP server is serving (the container migrates the DB on boot before
// serving, so a reachable `/health` also implies migrations succeeded). Kept dependency-free
// on purpose: a liveness probe must not fail — and restart the pod — when Postgres blips.
export const GET: Endpoint = async () => {
  return new Response('ok\n', {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  })
}
