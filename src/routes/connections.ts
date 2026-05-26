import { logger } from '../lib/logger'
import { FastifyInstance } from 'fastify'
import sql from '../db'
import { authenticate } from '../middleware/auth'
import { runFamilySnapshotBackfill } from '../services/snapshots/family'
import { ConnectionRequestSchema, ApproveConnectionSchema, FamilyToggleSchema } from '../schemas'

const CAN_VIEW_TTL_MS = 60_000
const canViewCache = new Map<string, { result: boolean; cachedAt: number }>()

export function invalidateCanViewCache(userA: string, userB: string): void {
  canViewCache.delete(`${userA}:${userB}`)
  canViewCache.delete(`${userB}:${userA}`)
}

export async function canViewUser(requesterId: string, targetId: string): Promise<boolean> {
  if (requesterId === targetId) return true
  const key = `${requesterId}:${targetId}`
  const cached = canViewCache.get(key)
  if (cached && Date.now() - cached.cachedAt < CAN_VIEW_TTL_MS) {
    return cached.result
  }
  const [conn] = await sql`
    SELECT id FROM family_connections
    WHERE ((requester_id = ${requesterId} AND owner_id = ${targetId})
        OR (requester_id = ${targetId} AND owner_id = ${requesterId}))
      AND status = 'active'
  `
  const result = !!conn
  canViewCache.set(key, { result, cachedAt: Date.now() })
  return result
}

export async function connectionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // ----------------------------------------------------------------
  // GET /connections/members - accepted connections for family filter
  // ----------------------------------------------------------------
  app.get('/connections/members', async (request) => {
    const members = await sql`
      SELECT
        CASE WHEN fc.requester_id = ${request.user.id} THEN fc.owner_id ELSE fc.requester_id END AS id,
        CASE WHEN fc.requester_id = ${request.user.id} THEN o.name ELSE r.name END AS name
      FROM family_connections fc
      JOIN users r ON r.id = fc.requester_id
      JOIN users o ON o.id = fc.owner_id
      WHERE (fc.requester_id = ${request.user.id} OR fc.owner_id = ${request.user.id})
        AND fc.status = 'active'
      ORDER BY name ASC
    `
    return { members }
  })

  // ----------------------------------------------------------------
  // GET /connections
  // ----------------------------------------------------------------
  app.get('/connections', async (request) => {
    const connections = await sql`
      SELECT
        fc.id,
        fc.status,
        fc.access_level,
        fc.requested_at,
        fc.responded_at,
        fc.requester_id,
        fc.owner_id,
        r.name  AS requester_name,
        r.profile_code AS requester_code,
        o.name  AS owner_name,
        o.profile_code AS owner_code
      FROM family_connections fc
      JOIN users r ON r.id = fc.requester_id
      JOIN users o ON o.id = fc.owner_id
      WHERE (fc.requester_id = ${request.user.id} OR fc.owner_id = ${request.user.id})
        AND fc.status != 'disconnected'
      ORDER BY fc.requested_at DESC
    `
    return connections
  })

  // ----------------------------------------------------------------
  // POST /connections/request
  // ----------------------------------------------------------------
  app.post('/connections/request', async (request, reply) => {
    const parsed = ConnectionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
    }
    const { profile_code } = parsed.data

    const [target] = await sql`
      SELECT id FROM users WHERE profile_code = ${profile_code} AND is_deleted = false
    `
    if (!target) return reply.code(404).send({ error: 'User not found' })
    if (target.id === request.user.id) return reply.code(400).send({ error: 'Cannot connect with yourself' })

    // check for existing pending or active connection in either direction
    const existing = await sql`
      SELECT id, status FROM family_connections
      WHERE (
        (requester_id = ${request.user.id} AND owner_id = ${target.id})
        OR
        (requester_id = ${target.id} AND owner_id = ${request.user.id})
      )
      AND status IN ('pending', 'active')
    `
    if (existing.length > 0) {
      return reply.code(409).send({ error: 'Connection already exists or pending' })
    }

    const [connection] = await sql`
      INSERT INTO family_connections (requester_id, owner_id)
      VALUES (${request.user.id}, ${target.id})
      RETURNING id, status, requested_at
    `

    return connection
  })

  // ----------------------------------------------------------------
  // PATCH /connections/:id/approve
  // ----------------------------------------------------------------
  app.patch<{ Params: { id: string } }>(
    '/connections/:id/approve',
    async (request, reply) => {
      const parsed = ApproveConnectionSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
      }
      const { access_level } = parsed.data

      const [connection] = await sql`
        SELECT id, owner_id, status FROM family_connections WHERE id = ${request.params.id}
      `
      if (!connection) return reply.code(404).send({ error: 'Connection not found' })
      if (connection.owner_id !== request.user.id) return reply.code(403).send({ error: 'Only the portfolio owner can approve' })
      if (connection.status !== 'pending') return reply.code(400).send({ error: 'Connection is not pending' })

      const [updated] = await sql`
        UPDATE family_connections
        SET status = 'active', access_level = ${access_level}, responded_at = NOW()
        WHERE id = ${request.params.id}
        RETURNING id, status, access_level, responded_at, requester_id, owner_id
      `

      invalidateCanViewCache(updated.requester_id as string, updated.owner_id as string)

      // Assign family_id to both users
      const familyId = await assignFamilyId(updated.requester_id as string, updated.owner_id as string)

      // Fire backfill in background - does not block the response
      runFamilySnapshotBackfill(familyId).catch(err => {
        logger.error({ err }, '[connections] family snapshot backfill error:')
      })

      return updated
    }
  )

  // ----------------------------------------------------------------
  // DELETE /connections/:id - disconnect (either side)
  // ----------------------------------------------------------------
  app.delete<{ Params: { id: string } }>('/connections/:id', async (request, reply) => {
    const [connection] = await sql`
      SELECT id, requester_id, owner_id, status FROM family_connections WHERE id = ${request.params.id}
    `
    if (!connection) return reply.code(404).send({ error: 'Connection not found' })

    const isMember = connection.requester_id === request.user.id || connection.owner_id === request.user.id
    if (!isMember) return reply.code(403).send({ error: 'Forbidden' })
    if (connection.status === 'disconnected') return reply.code(400).send({ error: 'Already disconnected' })

    // Capture family_id before the status change for the backfill trigger
    const [anyMember] = await sql`
      SELECT family_id::text FROM users WHERE id = ${connection.requester_id}
    `

    await sql`
      UPDATE family_connections
      SET status = 'disconnected', disconnected_at = NOW(), disconnected_by = ${request.user.id}
      WHERE id = ${request.params.id}
    `

    invalidateCanViewCache(connection.requester_id as string, connection.owner_id as string)

    // Regenerate family snapshots without this member's data going forward
    if (anyMember?.family_id) {
      runFamilySnapshotBackfill(anyMember.family_id as string).catch(err => {
        logger.error({ err }, '[connections] family snapshot backfill error:')
      })
    }

    return { ok: true }
  })

  // ----------------------------------------------------------------
  // PATCH /connections/:id/family - toggle include_in_family
  // ----------------------------------------------------------------
  app.patch<{ Params: { id: string } }>(
    '/connections/:id/family',
    async (request, reply) => {
      const parsed = FamilyToggleSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
      }
      const { include_in_family } = parsed.data

      const [connection] = await sql`
        SELECT id, requester_id, owner_id, status
        FROM family_connections
        WHERE id = ${request.params.id}
      `
      if (!connection) return reply.code(404).send({ error: 'Connection not found' })

      const isMember = connection.requester_id === request.user.id || connection.owner_id === request.user.id
      if (!isMember) return reply.code(403).send({ error: 'Forbidden' })
      if (connection.status !== 'active') return reply.code(400).send({ error: 'Connection is not active' })

      await sql`
        UPDATE family_connections
        SET include_in_family = ${include_in_family}
        WHERE id = ${request.params.id}
      `

      const [anyMember] = await sql`
        SELECT family_id::text FROM users WHERE id = ${connection.requester_id}
      `

      if (anyMember?.family_id) {
        runFamilySnapshotBackfill(anyMember.family_id as string).catch(err => {
          logger.error({ err }, '[connections] family snapshot backfill error:')
        })
      }

      return { ok: true, include_in_family }
    }
  )
}

// ---------------------------------------------------------------------------
// Assign family_id to two users who just connected.
// Neither has one: generate a new UUID and assign to both.
// One has one: the other inherits it.
// Both have different ones: migrate the smaller group into the larger group.
// ---------------------------------------------------------------------------
async function assignFamilyId(userAId: string, userBId: string): Promise<string> {
  const [a] = await sql`SELECT family_id::text FROM users WHERE id = ${userAId}`
  const [b] = await sql`SELECT family_id::text FROM users WHERE id = ${userBId}`

  const aId = a?.family_id as string | null
  const bId = b?.family_id as string | null

  if (!aId && !bId) {
    const [row] = await sql`SELECT gen_random_uuid()::text AS id`
    const newId = row.id as string
    await sql`UPDATE users SET family_id = ${newId} WHERE id IN (${userAId}, ${userBId})`
    return newId
  }

  if (aId && !bId) {
    await sql`UPDATE users SET family_id = ${aId} WHERE id = ${userBId}`
    return aId
  }

  if (!aId && bId) {
    await sql`UPDATE users SET family_id = ${bId} WHERE id = ${userAId}`
    return bId
  }

  if (aId === bId) return aId!

  // Both have different family_ids - merge smaller group into larger group
  const [aCount] = await sql`SELECT COUNT(*)::int AS n FROM users WHERE family_id = ${aId}`
  const [bCount] = await sql`SELECT COUNT(*)::int AS n FROM users WHERE family_id = ${bId}`

  const keepId = (bCount.n as number) >= (aCount.n as number) ? bId! : aId!
  const mergeId = keepId === bId ? aId! : bId!

  await sql`UPDATE users SET family_id = ${keepId} WHERE family_id = ${mergeId}`
  return keepId
}
