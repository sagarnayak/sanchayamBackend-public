import { FastifyInstance } from 'fastify'
import sql from '../db'
import { authenticate } from '../middleware/auth'
import { enqueue } from '../services/prices'
import { canViewUser } from './connections'
import { CreateHoldingSchema, UpdateHoldingSchema } from '../schemas'

export async function holdingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // List holdings - optionally for a connected user via ?forUserId=<id>
  app.get<{ Querystring: { forUserId?: string; status?: string } }>('/holdings', async (req, reply) => {
    const requesterId = req.user.id
    const forUserId = req.query.forUserId ?? requesterId

    if (forUserId !== requesterId && !(await canViewUser(requesterId, forUserId))) {
      return reply.code(403).send({ error: 'No active connection with this user' })
    }

    const { status } = req.query

    const holdings = await sql`
      SELECT
        h.id, h.asset_id, h.user_id, h.custom_name, h.unit_label, h.status, h.tags, h.remarks,
        h.created_at, h.updated_at,
        a.name AS asset_name, a.currency, a.unit_type, a.update_mode,
        a.cost_basis_mode, a.symbol, a.data_type,
        a.locked_unit_cost,
        cur.decimals AS currency_decimals
      FROM holdings h
      JOIN assets a ON a.id = h.asset_id
      JOIN currencies cur ON cur.code = a.currency
      WHERE h.user_id = ${forUserId}
        AND h.is_deleted = false
        ${status ? sql`AND h.status = ${status}` : sql``}
      ORDER BY h.created_at DESC
    `

    return {
      holdings: holdings.map(h => ({
        ...h,
        display_name: h.custom_name ?? h.asset_name,
      })),
    }
  })

  // Single holding by ID
  app.get('/holdings/:id', async (req, reply) => {
    const userId = req.user.id
    const { id } = req.params as { id: string }

    const [h] = await sql`
      SELECT
        h.id, h.asset_id, h.user_id, h.custom_name, h.unit_label, h.status, h.tags, h.remarks,
        h.created_at, h.updated_at,
        a.name AS asset_name, a.currency, a.unit_type, a.update_mode,
        a.cost_basis_mode, a.symbol, a.data_type,
        a.locked_unit_cost,
        cur.decimals AS currency_decimals
      FROM holdings h
      JOIN assets a ON a.id = h.asset_id
      JOIN currencies cur ON cur.code = a.currency
      WHERE h.id = ${id} AND h.user_id = ${userId} AND h.is_deleted = false
    `
    if (!h) return reply.status(404).send({ error: 'Holding not found' })

    return { holding: { ...h, display_name: h.custom_name ?? h.asset_name } }
  })

  // Create a holding
  app.post('/holdings', async (req, reply) => {
    const userId = req.user.id
    const parsed = CreateHoldingSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
    }
    const body = parsed.data

    const [asset] = await sql`
      SELECT id, is_active, update_mode FROM assets WHERE id = ${body.asset_id} AND is_deleted = false
    `
    if (!asset) return reply.status(404).send({ error: 'Asset not found' })
    if (!asset.is_active) return reply.status(409).send({ error: 'Asset is not active' })

    const [existing] = await sql`
      SELECT id FROM holdings WHERE user_id = ${userId} AND asset_id = ${body.asset_id} AND is_deleted = false
    `
    if (existing) return reply.status(409).send({ error: 'You already have a holding for this asset' })

    const [holding] = await sql`
      INSERT INTO holdings (user_id, asset_id, custom_name, unit_label, tags, remarks)
      VALUES (
        ${userId}, ${body.asset_id},
        ${body.custom_name ?? null}, ${body.unit_label ?? null},
        ${sql.json(body.tags ?? [])},
        ${body.remarks ?? null}
      )
      RETURNING *
    `
    // Queue a price fetch for api-mode assets (priority 1 = user-triggered)
    if (asset.update_mode === 'api') {
      enqueue(holding.asset_id, 1).catch(() => {})
    }

    return reply.status(201).send({ holding })
  })

  // Update a holding (metadata only)
  app.patch('/holdings/:id', async (req, reply) => {
    const userId = req.user.id
    const { id } = req.params as { id: string }
    const parsed = UpdateHoldingSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
    }
    const body = parsed.data

    const [holding] = await sql`
      SELECT id FROM holdings WHERE id = ${id} AND user_id = ${userId} AND is_deleted = false
    `
    if (!holding) return reply.status(404).send({ error: 'Holding not found' })

    const [updated] = await sql`
      UPDATE holdings SET
        custom_name = COALESCE(${body.custom_name ?? null}, custom_name),
        unit_label  = COALESCE(${body.unit_label ?? null}, unit_label),
        tags        = COALESCE(${body.tags !== undefined ? sql.json(body.tags) : null}, tags),
        remarks     = COALESCE(${body.remarks ?? null}, remarks),
        status      = COALESCE(${body.status ?? null}, status),
        updated_at  = NOW()
      WHERE id = ${id}
      RETURNING *
    `
    return { holding: updated }
  })

  // Soft delete a holding
  app.delete('/holdings/:id', async (req, reply) => {
    const userId = req.user.id
    const { id } = req.params as { id: string }

    const [holding] = await sql`
      SELECT id FROM holdings WHERE id = ${id} AND user_id = ${userId} AND is_deleted = false
    `
    if (!holding) return reply.status(404).send({ error: 'Holding not found' })

    await sql`UPDATE holdings SET is_deleted = true, deleted_at = NOW(), updated_at = NOW() WHERE id = ${id}`
    return { ok: true }
  })
}
