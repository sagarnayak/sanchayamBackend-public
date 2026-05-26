import { FastifyRequest, FastifyReply } from 'fastify'
import { verifyAccessToken } from '../services/auth'
import sql from '../db'

const FORCE_LOGOUT_TTL_MS = 60_000

type ForceLogoutEntry = { loggedOutAt: number | null; cachedAt: number }
const forceLogoutCache = new Map<string, ForceLogoutEntry>()

async function getForceLogoutTimestamp(userId: string): Promise<number | null> {
  const cached = forceLogoutCache.get(userId)
  if (cached && Date.now() - cached.cachedAt < FORCE_LOGOUT_TTL_MS) {
    return cached.loggedOutAt
  }
  const rows = await sql`SELECT logged_out_at FROM force_logout WHERE user_id = ${userId}`
  const loggedOutAt = rows.length > 0 ? new Date(rows[0].logged_out_at).getTime() / 1000 : null
  forceLogoutCache.set(userId, { loggedOutAt, cachedAt: Date.now() })
  return loggedOutAt
}

export function invalidateForceLogoutCache(userId: string): void {
  forceLogoutCache.delete(userId)
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Unauthorized' })
    return
  }

  const token = header.slice(7)
  let payload: { sub: string; adm: boolean; iat: number }

  try {
    payload = verifyAccessToken(token)
  } catch {
    reply.code(401).send({ error: 'Invalid or expired token' })
    return
  }

  const loggedOutAt = await getForceLogoutTimestamp(payload.sub)
  if (loggedOutAt !== null && payload.iat <= loggedOutAt) {
    reply.code(401).send({ error: 'Session invalidated' })
    return
  }

  request.user = { id: payload.sub, isMasterAdmin: payload.adm }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticate(request, reply)
  if (reply.sent) return
  if (!request.user.isMasterAdmin) {
    reply.code(403).send({ error: 'Forbidden' })
  }
}
