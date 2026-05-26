import { FastifyInstance } from 'fastify'
import sql from '../db'
import { requireAdmin } from '../middleware/auth'
import { CreateAssetSchema, UpdateAssetSchema } from '../schemas'

export async function adminAssetsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // Currencies list for dropdowns
  app.get('/admin/currencies', async () => {
    const currencies = await sql`
      SELECT code, name, symbol, decimals, is_crypto
      FROM currencies
      WHERE is_active = true
      ORDER BY is_crypto ASC, code ASC
    `
    return { currencies }
  })

  // List all assets
  app.get('/admin/assets', async (req) => {
    const { is_active, update_mode } = req.query as Record<string, string>

    const assets = await sql`
      SELECT
        a.id, a.name, a.currency, a.unit_type, a.update_mode,
        a.update_frequency, a.data_type, a.symbol,
        a.cost_basis_mode, a.is_active, a.created_at, a.updated_at,
        a.locked_unit_cost,
        COUNT(h.id) FILTER (WHERE h.is_deleted = false)::int AS holding_count
      FROM assets a
      LEFT JOIN holdings h ON h.asset_id = a.id
      WHERE a.is_deleted = false
        ${is_active !== undefined ? sql`AND a.is_active = ${is_active === 'true'}` : sql``}
        ${update_mode ? sql`AND a.update_mode = ${update_mode}` : sql``}
      GROUP BY a.id
      ORDER BY a.name ASC
    `
    return { assets }
  })

  // Create asset
  app.post('/admin/assets', async (req, reply) => {
    const parsed = CreateAssetSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
    }
    const body = parsed.data
    const { name, currency, unit_type, update_mode, cost_basis_mode } = body
    if (update_mode === 'api' && (!body.data_type || !body.symbol)) {
      return reply.status(400).send({ error: 'data_type and symbol are required for api mode assets' })
    }
    if (cost_basis_mode === 'floating' && unit_type !== 'single') {
      return reply.status(400).send({ error: 'floating cost_basis_mode is only valid for single unit_type assets' })
    }

    const update_frequency = update_mode === 'api' ? 'daily' : 'as_required'
    const locked_unit_cost = body.locked_unit_cost ? body.locked_unit_cost : null

    let asset: Record<string, unknown>
    try {
      ;[asset] = await sql`
        INSERT INTO assets (name, currency, unit_type, update_mode, update_frequency, data_type, symbol, cost_basis_mode, locked_unit_cost)
        VALUES (
          ${name}, ${currency}, ${unit_type}, ${update_mode}, ${update_frequency},
          ${body.data_type ?? null}, ${body.symbol ?? null}, ${cost_basis_mode},
          ${locked_unit_cost}
        )
        RETURNING *
      `
    } catch (err: any) {
      if (err?.code === '23505') {
        return reply.status(409).send({ error: `An asset named "${name}" already exists` })
      }
      throw err
    }
    return reply.status(201).send({ asset })
  })

  // Update asset
  app.patch('/admin/assets/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = UpdateAssetSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors })
    }
    const body = parsed.data

    const [existing] = await sql`SELECT id FROM assets WHERE id = ${id} AND is_deleted = false`
    if (!existing) return reply.status(404).send({ error: 'Asset not found' })

    const [asset] = await sql`
      UPDATE assets SET
        name       = COALESCE(${body.name ?? null}, name),
        currency   = COALESCE(${body.currency ?? null}, currency),
        data_type  = COALESCE(${body.data_type ?? null}, data_type),
        symbol     = COALESCE(${body.symbol ?? null}, symbol),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `
    return { asset }
  })

  // Deactivate (hide from users without deleting)
  app.patch('/admin/assets/:id/deactivate', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [existing] = await sql`SELECT id FROM assets WHERE id = ${id} AND is_deleted = false`
    if (!existing) return reply.status(404).send({ error: 'Asset not found' })

    await sql`UPDATE assets SET is_active = false, updated_at = NOW() WHERE id = ${id}`
    return { ok: true }
  })

  // Reactivate
  app.patch('/admin/assets/:id/activate', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [existing] = await sql`SELECT id FROM assets WHERE id = ${id} AND is_deleted = false`
    if (!existing) return reply.status(404).send({ error: 'Asset not found' })

    await sql`UPDATE assets SET is_active = true, updated_at = NOW() WHERE id = ${id}`
    return { ok: true }
  })

  // Soft delete
  app.delete('/admin/assets/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [existing] = await sql`SELECT id FROM assets WHERE id = ${id} AND is_deleted = false`
    if (!existing) return reply.status(404).send({ error: 'Asset not found' })

    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM holdings
      WHERE asset_id = ${id} AND is_deleted = false
    `
    if (count > 0) {
      return reply.status(409).send({ error: 'Cannot delete an asset with active holdings' })
    }

    await sql`UPDATE assets SET is_deleted = true, deleted_at = NOW(), updated_at = NOW() WHERE id = ${id}`
    return { ok: true }
  })
}
