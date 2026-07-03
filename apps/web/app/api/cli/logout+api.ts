import { cliLogoutEndpoint } from '@press/web/auth/cliFlow'

import type { Endpoint } from 'one'

export const POST: Endpoint = async (request) => cliLogoutEndpoint(request)
