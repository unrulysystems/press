import { servedPageEndpoint } from '@press/web/publish/serving'

import type { Endpoint } from 'one'

export const GET: Endpoint = async (request) => servedPageEndpoint(request)
