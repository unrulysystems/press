import { auth } from '@press/web/auth/server'

import type { Endpoint } from 'one'

export const GET: Endpoint = async (request) => {
  const session = await auth.api.getSession({
    headers: request.headers,
  })

  if (!session) {
    return Response.json({ authenticated: false }, { status: 401 })
  }
  const user = session.user as typeof session.user & { readonly role?: string }

  return Response.json({
    authenticated: true,
    user: {
      id: session.user.id,
      email: session.user.email,
      role: user.role ?? 'user',
    },
  })
}
