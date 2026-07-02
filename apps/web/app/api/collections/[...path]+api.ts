import { collectionsEndpoint } from '@press/web/publish/routes'

import type { Endpoint } from 'one'

export const GET: Endpoint = async (request) => collectionsEndpoint(request)
export const PATCH: Endpoint = async (request) => collectionsEndpoint(request)
