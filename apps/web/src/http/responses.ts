import { SlugValidationError } from '@press/core'

import { BodyTooLargeError, readCappedBodyText } from './readBody'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'HttpError'
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function safeRequestPath(request?: Request): string | undefined {
  if (!request) {
    return undefined
  }
  try {
    return new URL(request.url).pathname
  } catch {
    return undefined
  }
}

export function logServerError(operation: string, error: unknown, request?: Request): void {
  const record = {
    level: 'error',
    event: 'http_internal_error',
    operation,
    ...(request ? { method: request.method } : {}),
    ...(safeRequestPath(request) ? { path: safeRequestPath(request) } : {}),
    errorName: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  }
  console.error(JSON.stringify(record))
}

export function logServerWarning(
  operation: string,
  detail: Record<string, unknown>,
  error?: unknown,
): void {
  const record = {
    level: 'warn',
    event: 'server_warning',
    operation,
    ...detail,
    ...(error !== undefined
      ? {
          errorName: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        }
      : {}),
  }
  console.warn(JSON.stringify(record))
}

export function jsonErrorResponse(operation: string, error: unknown, request?: Request): Response {
  if (error instanceof HttpError) {
    return jsonResponse({ error: error.message }, error.status)
  }
  if (error instanceof BodyTooLargeError) {
    return jsonResponse({ error: error.message }, error.status)
  }
  if (error instanceof SlugValidationError) {
    return jsonResponse({ error: error.message }, 400)
  }
  logServerError(operation, error, request)
  return jsonResponse({ error: 'internal server error' }, 500)
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export async function readBoundedJsonObject(
  request: Request,
  byteLimit: number,
): Promise<Record<string, unknown>> {
  const text = await readCappedBodyText(request, byteLimit)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error) {
    throw new HttpError(400, 'request body must be JSON', { cause: error })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'request body must be a JSON object')
  }
  return body as Record<string, unknown>
}
