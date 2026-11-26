import { getAuth } from '@press/web/auth/server'
import { loadActiveViewerForUserId } from '@press/web/auth/sessionViewer'
import { getDb, getDbConfig } from '@press/web/db/client'

import type { Endpoint } from 'one'

export const GET: Endpoint = async (request) => {
  const session = await getAuth().api.getSession({
    headers: request.headers,
  })

  if (!session) {
    return Response.json({ authenticated: false }, { status: 401 })
  }

  const viewer = await loadActiveViewerForUserId(
    getDb(),
    session.user.id,
    getDbConfig().adminEmails,
  )
  if (!viewer) {
    return Response.json({ authenticated: false }, { status: 401 })
  }

  return Response.json({
    authenticated: true,
    user: {
      id: viewer.userId,
      email: viewer.email,
      role: viewer.role,
    },
  })
}
