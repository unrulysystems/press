import { pagesEndpoint } from '@press/web/publish/routes'

import type { Endpoint } from 'one'

export const DELETE: Endpoint = async (request) => pagesEndpoint(request)
export const PATCH: Endpoint = async (request) => pagesEndpoint(request)
export const POST: Endpoint = async (request) => pagesEndpoint(request)
export const PUT: Endpoint = async (request) => pagesEndpoint(request)
