import { auth } from '@press/web/auth/server'
import { roleForEmail } from '@press/web/auth/role'
import { dbConfig } from '@press/web/db/client'

import type { Endpoint } from 'one'

export const GET: Endpoint = async (request) => {
  const session = await auth.api.getSession({
    headers: request.headers,
  })

  if (!session) {
    return Response.json({ authenticated: false }, { status: 401 })
  }

  return Response.json({
    authenticated: true,
    user: {
      id: session.user.id,
      email: session.user.email,
      // Effective admin role derives from PRESS_ADMIN_EMAILS, not the cached row (B-2).
      role: roleForEmail(session.user.email, dbConfig.adminEmails),
    },
  })
}
