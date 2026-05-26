import { FastifyInstance } from 'fastify'
import sql from '../db'
import { authenticate } from '../middleware/auth'
import { canViewUser } from './connections'
import { CreateLotSchema } from '../schemas'

export async function lotsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // List lots for a holding (own or connected user)
  app.get('/holdings/:id/lots', async (req, reply) => {
    const userId = req.user.id
    const { id: holdingId } = req.params as { id: string }

    const [holding] = await sql`
      SELECT id, user_id FROM holdings WHERE id = ${holdingId} AND is_deleted = false
    `
    if (!holding) return reply.status(404).send({ error: 'Holding not found' })
    if (holding.user_id !== userId && !(await canViewUser(userId, holding.user_id as string))) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const lots = await sql`
      SELECT id, transaction_type, quantity, remaining_quantity, price_per_unit, cost_basis_minor, transaction_date, notes, created_at
      FROM lots
      WHERE holding_id = ${holdingId} AND is_deleted = false
      ORDER BY transaction_date ASC, created_at ASC
    `
    return { lots }
  })

  // Record a buy or sell
  app.post('/holdings/:id/lots', async (req, reply) => {
    const userId = req.user.id
    const { id: holdingId } = req.params as { id: string }
    const parsed = CreateLotSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
    }
    const body = parsed.data
    const { transaction_type, quantity, price_per_unit, transaction_date } = body

    const [holding] = await sql`
      SELECT h.id, a.cost_basis_mode, a.unit_type
      FROM holdings h
      JOIN assets a ON a.id = h.asset_id
      WHERE h.id = ${holdingId} AND h.user_id = ${userId} AND h.is_deleted = false
    `
    if (!holding) return reply.status(404).send({ error: 'Holding not found' })
    if (holding.cost_basis_mode !== 'fixed') {
      return reply.status(409).send({ error: 'Lots are only applicable to fixed cost_basis_mode holdings' })
    }

    const sellQtyNum = parseFloat(quantity)
    if (!sellQtyNum || sellQtyNum <= 0) {
      return reply.status(400).send({ error: 'Quantity must be greater than zero' })
    }
    const sellQty = BigInt(Math.round(sellQtyNum))

    if (transaction_type === 'buy') {
      const [lot] = await sql`
        INSERT INTO lots (holding_id, transaction_type, quantity, remaining_quantity, price_per_unit, transaction_date, notes)
        VALUES (${holdingId}, 'buy', ${quantity}, ${quantity}, ${price_per_unit}, ${transaction_date}, ${body.notes ?? null})
        RETURNING *
      `
      return reply.status(201).send({ lot })
    }

    // --- FIFO sell ---
    const buyLots = await sql`
      SELECT id, remaining_quantity, price_per_unit
      FROM lots
      WHERE holding_id = ${holdingId}
        AND transaction_type = 'buy'
        AND remaining_quantity > 0
        AND is_deleted = false
      ORDER BY transaction_date ASC, created_at ASC
    `

    const totalAvailable = buyLots.reduce((sum, l) => sum + BigInt(Math.round(parseFloat(l.remaining_quantity))), 0n)
    if (sellQty > totalAvailable) {
      return reply.status(409).send({ error: `Sell quantity exceeds available: have ${totalAvailable.toString()}, selling ${sellQty.toString()}` })
    }

    // Walk FIFO: reduce buy lots and accumulate cost basis
    let remaining = sellQty
    let costBasisMinor = 0n
    for (const lot of buyLots) {
      if (remaining === 0n) break
      const lotQty = BigInt(Math.round(parseFloat(lot.remaining_quantity)))
      const reduce = lotQty < remaining ? lotQty : remaining
      const newQty = lotQty - reduce
      await sql`UPDATE lots SET remaining_quantity = ${newQty.toString()} WHERE id = ${lot.id}`
      costBasisMinor += reduce * BigInt(Math.round(parseFloat(lot.price_per_unit)))
      remaining -= reduce
    }

    // Record the sell lot with its locked-in cost basis
    const [sellLot] = await sql`
      INSERT INTO lots (holding_id, transaction_type, quantity, remaining_quantity, price_per_unit, cost_basis_minor, transaction_date, notes)
      VALUES (${holdingId}, 'sell', ${quantity}, null, ${price_per_unit}, ${costBasisMinor.toString()}, ${transaction_date}, ${body.notes ?? null})
      RETURNING *
    `

    // Check if fully exited
    const [{ net }] = await sql`
      SELECT COALESCE(SUM(remaining_quantity), 0) AS net
      FROM lots
      WHERE holding_id = ${holdingId} AND transaction_type = 'buy' AND is_deleted = false
    `
    const netQty = BigInt(Math.round(parseFloat(net)))
    if (netQty === 0n) {
      await sql`UPDATE holdings SET status = 'exited', updated_at = NOW() WHERE id = ${holdingId}`
    }

    return reply.status(201).send({ lot: sellLot, exited: netQty === 0n })
  })

  // Bulk: all lots for all holdings of a user in one query
  app.get<{ Querystring: { forUserId?: string } }>('/holdings/lots/bulk', async (req, reply) => {
    const requesterId = req.user.id
    const forUserId = req.query.forUserId ?? requesterId

    if (forUserId !== requesterId && !(await canViewUser(requesterId, forUserId))) {
      return reply.code(403).send({ error: 'No active connection with this user' })
    }

    const lots = await sql`
      SELECT l.id, l.holding_id, l.transaction_type, l.quantity, l.remaining_quantity,
             l.price_per_unit, l.cost_basis_minor, l.transaction_date, l.notes, l.created_at
      FROM lots l
      JOIN holdings h ON h.id = l.holding_id
      WHERE h.user_id = ${forUserId}
        AND h.is_deleted = false
        AND l.is_deleted = false
      ORDER BY l.transaction_date ASC, l.created_at ASC
    `
    return { lots }
  })

  // All lots for a specific asset (individual or family), used by AssetDetail page
  app.get<{ Querystring: { forUserId?: string; family?: string } }>(
    '/holdings/lots/asset/:assetId',
    async (req, reply) => {
      const requesterId = req.user.id
      const { assetId } = req.params as { assetId: string }
      const { forUserId, family } = req.query

      if (family === 'true') {
        const [user] = await sql`
          SELECT family_id::text AS family_id FROM users WHERE id = ${requesterId}
        `
        if (!user?.family_id) return reply.code(404).send({ error: 'No family group found' })

        const lots = await sql`
          SELECT l.id, l.holding_id, h.asset_id, l.transaction_type, l.quantity,
                 l.remaining_quantity, l.price_per_unit, l.cost_basis_minor,
                 l.transaction_date, l.notes, l.created_at,
                 u.display_name AS owner_name
          FROM lots l
          JOIN holdings h ON h.id = l.holding_id
          JOIN users u ON u.id = h.user_id
          WHERE h.asset_id = ${assetId}
            AND u.family_id = ${user.family_id as string}
            AND h.is_deleted = false
            AND l.is_deleted = false
          ORDER BY l.transaction_date ASC, l.created_at ASC
        `
        return { lots }
      }

      const targetId = forUserId ?? requesterId
      if (forUserId && forUserId !== requesterId && !(await canViewUser(requesterId, forUserId))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const lots = await sql`
        SELECT l.id, l.holding_id, h.asset_id, l.transaction_type, l.quantity,
               l.remaining_quantity, l.price_per_unit, l.cost_basis_minor,
               l.transaction_date, l.notes, l.created_at
        FROM lots l
        JOIN holdings h ON h.id = l.holding_id
        WHERE h.asset_id = ${assetId}
          AND h.user_id = ${targetId}
          AND h.is_deleted = false
          AND l.is_deleted = false
        ORDER BY l.transaction_date ASC, l.created_at ASC
      `
      return { lots }
    }
  )

  // Soft delete a lot (data correction only)
  app.delete('/holdings/:id/lots/:lotId', async (req, reply) => {
    const userId = req.user.id
    const { id: holdingId, lotId } = req.params as { id: string; lotId: string }

    const [holding] = await sql`
      SELECT id FROM holdings WHERE id = ${holdingId} AND user_id = ${userId} AND is_deleted = false
    `
    if (!holding) return reply.status(404).send({ error: 'Holding not found' })

    const [lot] = await sql`
      SELECT id FROM lots WHERE id = ${lotId} AND holding_id = ${holdingId} AND is_deleted = false
    `
    if (!lot) return reply.status(404).send({ error: 'Lot not found' })

    await sql`UPDATE lots SET is_deleted = true, deleted_at = NOW() WHERE id = ${lotId}`
    return { ok: true }
  })
}
