import { FastifyInstance } from 'fastify'
import sql from '../db'
import { authenticate } from '../middleware/auth'
import { getLatestPricesBulk } from '../services/prices'
import { getRateSafe } from '../services/fx'
import { canViewUser } from './connections'

const BASE_CURRENCY_TTL_MS = 5 * 60 * 1000
const baseCurrencyCache = new Map<string, { value: string; cachedAt: number }>()

export async function getBaseCurrency(userId: string): Promise<string> {
  const cached = baseCurrencyCache.get(userId)
  if (cached && Date.now() - cached.cachedAt < BASE_CURRENCY_TTL_MS) return cached.value
  const [user] = await sql`SELECT base_currency FROM users WHERE id = ${userId}`
  const value = (user?.base_currency as string) ?? 'INR'
  baseCurrencyCache.set(userId, { value, cachedAt: Date.now() })
  return value
}

export function invalidateBaseCurrencyCache(userId: string): void {
  baseCurrencyCache.delete(userId)
}

export async function assetsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // Active assets available for users to hold
  app.get('/assets', async () => {
    const assets = await sql`
      SELECT id, name, currency, unit_type, update_mode, cost_basis_mode, symbol, data_type,
             locked_unit_cost
      FROM assets
      WHERE is_active = true AND is_deleted = false
      ORDER BY name ASC
    `
    return { assets }
  })

  // Price status for all api-mode assets the user currently holds
  // Optionally scoped to a connected user via ?forUserId=<id>
  app.get<{ Querystring: { forUserId?: string } }>('/assets/prices', async (req, reply) => {
    const requesterId = req.user.id
    const forUserId = req.query.forUserId ?? requesterId

    if (forUserId !== requesterId && !(await canViewUser(requesterId, forUserId))) {
      return reply.code(403).send({ error: 'No active connection with this user' })
    }

    const apiHoldings = await sql`
      SELECT DISTINCT a.id AS asset_id, a.name, a.symbol, a.data_type
      FROM holdings h
      JOIN assets a ON a.id = h.asset_id
      WHERE h.user_id = ${forUserId}
        AND h.is_deleted = false
        AND h.status = 'active'
        AND a.update_mode = 'api'
        AND a.data_type IS NOT NULL
        AND a.is_deleted = false
    `

    const priceMap = await getLatestPricesBulk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      apiHoldings.map((r: any) => ({ asset_id: r.asset_id, data_type: r.data_type }))
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = apiHoldings.map((row: any) => {
      const price = priceMap.get(row.asset_id) ?? null
      return {
        asset_id:    row.asset_id,
        name:        row.name,
        symbol:      row.symbol,
        data_type:   row.data_type,
        price:       price?.price ?? null,
        recorded_at: price?.recordedAt ?? null,
        is_stale:    price?.isStale ?? false,
        status:      price === null ? 'pending' : (price.isStale ? 'stale' : 'fresh'),
      }
    })

    return { prices: results }
  })

  // FX rates from given currencies to the user's base currency
  app.get<{ Querystring: { currencies?: string } }>('/fx/rates', async (req) => {
    const userId = req.user.id
    const baseCurrency = await getBaseCurrency(userId)

    const currencies = (req.query.currencies ?? '').split(',').map(c => c.trim()).filter(Boolean)
    const toFetch = currencies.filter(c => c !== baseCurrency)

    const resolved = await Promise.all(toFetch.map(c => getRateSafe(c, baseCurrency)))
    const rates: Record<string, number> = {}
    toFetch.forEach((c, i) => { if (resolved[i]) rates[c] = parseFloat(resolved[i]!) })

    return { base_currency: baseCurrency, rates }
  })
}
