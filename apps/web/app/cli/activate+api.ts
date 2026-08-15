import { cliDeviceActivateEndpoint } from '@press/web/auth/cliDeviceFlow'

import type { Endpoint } from 'one'

// Export every method so One dispatches them all to the endpoint, whose 405
// branch is then reachable through the real route (a missing export would
// fall through to a 404 instead of the endpoint's method-not-allowed).
export const GET: Endpoint = async (request) => cliDeviceActivateEndpoint(request)
export const POST: Endpoint = async (request) => cliDeviceActivateEndpoint(request)
export const PUT: Endpoint = async (request) => cliDeviceActivateEndpoint(request)
export const PATCH: Endpoint = async (request) => cliDeviceActivateEndpoint(request)
export const DELETE: Endpoint = async (request) => cliDeviceActivateEndpoint(request)
export const OPTIONS: Endpoint = async (request) => cliDeviceActivateEndpoint(request)
export const HEAD: Endpoint = async (request) => cliDeviceActivateEndpoint(request)
