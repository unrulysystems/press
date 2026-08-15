import { cliDeviceStartEndpoint } from '@press/web/auth/cliDeviceFlow'

import type { Endpoint } from 'one'

export const POST: Endpoint = async (request) => cliDeviceStartEndpoint(request)
