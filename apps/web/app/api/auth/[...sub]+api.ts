import { getAuth } from '@press/web/auth/server'

import type { Endpoint } from 'one'

export const GET: Endpoint = async (request) => getAuth().handler(request)
export const POST: Endpoint = async (request) => getAuth().handler(request)
