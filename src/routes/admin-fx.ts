import { FastifyInstance } from 'fastify'
import sql from '../db'
import { requireAdmin } from '../middleware/auth'

export async function adminFxRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // GET /admin/fx/overview
  // Returns cached FX rates with freshness status and recent FX alerts
  app.get('/admin/fx/overview', async () => {
    const rates = await sql`
      SELECT
        c.code             AS currency_code,
        c.name             AS currency_name,
        c.symbol,
        fr.rate_vs_pivot   AS rate_vs_usd,
        fr.fetched_at,
        CASE
          WHEN fr.currency_code IS NULL                        THEN 'never'
          WHEN fr.fetched_at < NOW() - INTERVAL '24 hours'    THEN 'stale'
          ELSE                                                      'fresh'
        END                AS status
      FROM currency_collector_map ccm
      JOIN currencies c ON c.code = ccm.currency_code
      LEFT JOIN fx_rates fr ON fr.currency_code = ccm.currency_code
      ORDER BY c.code
    `

    const alerts = await sql`
      SELECT id, type, payload, status, retry_count, created_at
      FROM notification_events
      WHERE type IN ('FX_RATE_UNAVAILABLE', 'PROVIDER_CALL_FAILED')
      ORDER BY created_at DESC
      LIMIT 20
    `

    return { rates, alerts }
  })
}
