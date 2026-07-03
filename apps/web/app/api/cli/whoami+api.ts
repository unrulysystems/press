import { cliWhoamiEndpoint } from '@press/web/auth/cliFlow'

import type { Endpoint } from 'one'

export const GET: Endpoint = async (request) => cliWhoamiEndpoint(request)
