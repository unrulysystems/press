import { collectionsIndexEndpoint } from '@press/web/publish/routes'

import type { Endpoint } from 'one'

export const GET: Endpoint = async (request) => collectionsIndexEndpoint(request)
