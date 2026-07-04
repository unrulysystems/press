import { servedPageEndpoint, servedPagePasswordEndpoint } from '@press/web/publish/serving'

import type { Endpoint } from 'one'

export const GET: Endpoint = async (request) => servedPageEndpoint(request)
// POST is the branded password-gate's unlock form target (REQ-SRV-004); it is a
// read-side cookie set, not a page mutation.
export const POST: Endpoint = async (request) => servedPagePasswordEndpoint(request)
