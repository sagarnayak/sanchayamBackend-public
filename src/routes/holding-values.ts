import { FastifyInstance } from 'fastify'
import sql from '../db'
import { authenticate } from '../middleware/auth'
import { canViewUser } from './connections'
import { CreateHoldingValueSchema } from '../schemas'

export async function holdingValuesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // Full value history for a holding (own or connected user)
  app.get('/holdings/:id/values', async (req, reply) => {
    const userId = req.user.id
    const { id: holdingId } = req.params as { id: string }

    const [holding] = await sql`
      SELECT id, user_id FROM holdings WHERE id = ${holdingId} AND is_deleted = false
    `
    if (!holding) return reply.status(404).send({ error: 'Holding not found' })
    if (holding.user_id !== userId && !(await canViewUser(userId, holding.user_id as string))) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const values = await sql`
      SELECT id, value, recorded_at, notes, created_at
      FROM holding_values
      WHERE holding_id = ${holdingId}
      ORDER BY recorded_at DESC
    `
    return { values }
  })

  // Bulk: all values for all holdings of a user in one query
  app.get<{ Querystring: { forUserId?: string } }>('/holdings/values/bulk', async (req, reply) => {
    const requesterId = req.user.id
    const forUserId = req.query.forUserId ?? requesterId

    if (forUserId !== requesterId && !(await canViewUser(requesterId, forUserId))) {
      return reply.code(403).send({ error: 'No active connection with this user' })
    }

    const values = await sql`
      SELECT v.id, v.holding_id, v.value, v.recorded_at, v.notes, v.created_at
      FROM holding_values v
      JOIN holdings h ON h.id = v.holding_id
      WHERE h.user_id = ${forUserId}
        AND h.is_deleted = false
      ORDER BY v.recorded_at DESC
    `
    return { values }
  })

  // Record a new value
  app.post('/holdings/:id/values', async (req, reply) => {
    const userId = req.user.id
    const { id: holdingId } = req.params as { id: string }
    const parsed = CreateHoldingValueSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
    }
    const body = parsed.data

    const [holding] = await sql`
      SELECT h.id, a.update_mode, a.cost_basis_mode
      FROM holdings h
      JOIN assets a ON a.id = h.asset_id
      WHERE h.id = ${holdingId} AND h.user_id = ${userId} AND h.is_deleted = false
    `
    if (!holding) return reply.status(404).send({ error: 'Holding not found' })
    if (holding.update_mode !== 'manual') {
      return reply.status(409).send({ error: 'Manual value updates are only applicable to manual update_mode assets' })
    }

    const recorded_at = body.recorded_at ?? new Date().toISOString()

    const [entry] = await sql`
      INSERT INTO holding_values (holding_id, value, recorded_at, notes)
      VALUES (${holdingId}, ${body.value}, ${recorded_at}, ${body.notes ?? null})
      RETURNING *
    `
    return reply.status(201).send({ value: entry })
  })
}
