import { cliDevicePollEndpoint } from '@press/web/auth/cliDeviceFlow'

import type { Endpoint } from 'one'

export const POST: Endpoint = async (request) => cliDevicePollEndpoint(request)
