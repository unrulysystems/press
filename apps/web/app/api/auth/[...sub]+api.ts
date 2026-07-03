import { auth } from '@press/web/auth/server'

import type { Endpoint } from 'one'

export const GET: Endpoint = async (request) => auth.handler(request)
export const POST: Endpoint = async (request) => auth.handler(request)
