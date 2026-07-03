import { cliExchangeEndpoint } from '@press/web/auth/cliFlow'

import type { Endpoint } from 'one'

export const POST: Endpoint = async (request) => cliExchangeEndpoint(request)
