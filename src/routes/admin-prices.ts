import { FastifyInstance } from 'fastify'
import sql from '../db'
import { requireAdmin } from '../middleware/auth'

const DATA_TYPES = ['equity_india', 'equity_us', 'crypto', 'mutual_fund_india'] as const

export async function adminPricesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/admin/prices/history/:dataType', async (req) => {
    const { dataType } = req.params as { dataType: string }
    const { asset_id, from, to, page = '1', limit = '50' } = req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(limit)
    const lim    = parseInt(limit)

    const assetF  = asset_id ? sql`AND a.id       = ${asset_id}` : sql``
    const phFromF = from     ? sql`AND aph.price_date  >= ${from}::date` : sql``
    const phToF   = to       ? sql`AND aph.price_date  <= ${to}::date`   : sql``
    const caFromF = from     ? sql`AND ca.action_date  >= ${from}::date` : sql``
    const caToF   = to       ? sql`AND ca.action_date  <= ${to}::date`   : sql``
    const aaFromF = from     ? sql`AND aa.from_date    >= ${from}::date` : sql``
    const aaToF   = to       ? sql`AND aa.from_date    <= ${to}::date`   : sql``

    const rows = await sql`
      WITH price_rows AS (
        SELECT
          aph.price_date::text                                                               AS event_date,
          a.id::text                                                                         AS asset_id,
          a.name                                                                             AS asset_name,
          a.symbol                                                                           AS asset_symbol,
          'price'::text                                                                      AS row_type,
          ROUND(aph.price::numeric / POWER(10, cur.decimals)::numeric, cur.decimals)::text  AS price,
          NULL::text                                                                         AS action_type,
          NULL::numeric                                                                      AS ratio_from,
          NULL::numeric                                                                      AS ratio_to,
          NULL::text                                                                         AS notes
        FROM asset_price_history aph
        JOIN assets     a   ON a.id = aph.asset_id
        JOIN currencies cur ON cur.code = a.currency
        WHERE a.data_type  = ${dataType}
          AND a.is_deleted = false
          ${assetF} ${phFromF} ${phToF}
      ),
      event_rows AS (
        SELECT
          ca.action_date::text      AS event_date,
          a.id::text                AS asset_id,
          a.name                    AS asset_name,
          a.symbol                  AS asset_symbol,
          'event'::text             AS row_type,
          NULL::text                AS price,
          ca.action_type::text      AS action_type,
          ca.ratio_from,
          ca.ratio_to,
          ca.notes
        FROM corporate_actions ca
        JOIN assets a ON a.id = ca.asset_id
        WHERE a.data_type  = ${dataType}
          AND a.is_deleted = false
          ${assetF} ${caFromF} ${caToF}
      ),
      alias_rows AS (
        SELECT
          aa.from_date::text        AS event_date,
          a.id::text                AS asset_id,
          a.name                    AS asset_name,
          a.symbol                  AS asset_symbol,
          'alias'::text             AS row_type,
          NULL::text                AS price,
          'symbol_change'::text     AS action_type,
          NULL::numeric             AS ratio_from,
          NULL::numeric             AS ratio_to,
          aa.symbol || COALESCE(' - ' || aa.name, '') AS notes
        FROM asset_aliases aa
        JOIN assets a ON a.id = aa.asset_id
        WHERE a.data_type  = ${dataType}
          AND a.is_deleted = false
          ${assetF} ${aaFromF} ${aaToF}
      )
      SELECT * FROM price_rows
      UNION ALL SELECT * FROM event_rows
      UNION ALL SELECT * FROM alias_rows
      ORDER BY event_date DESC, row_type ASC
      LIMIT ${lim} OFFSET ${offset}
    `

    const [{ total }] = await sql`
      SELECT COUNT(*)::int AS total FROM (
        SELECT aph.price_date AS d
        FROM asset_price_history aph
        JOIN assets a ON a.id = aph.asset_id
        WHERE a.data_type = ${dataType} AND a.is_deleted = false
          ${assetF} ${phFromF} ${phToF}
        UNION ALL
        SELECT ca.action_date
        FROM corporate_actions ca
        JOIN assets a ON a.id = ca.asset_id
        WHERE a.data_type = ${dataType} AND a.is_deleted = false
          ${assetF} ${caFromF} ${caToF}
        UNION ALL
        SELECT aa.from_date
        FROM asset_aliases aa
        JOIN assets a ON a.id = aa.asset_id
        WHERE a.data_type = ${dataType} AND a.is_deleted = false
          ${assetF} ${aaFromF} ${aaToF}
      ) t
    `

    const assets = await sql`
      SELECT DISTINCT a.id, a.name, a.symbol
      FROM assets a
      JOIN holdings h ON h.asset_id = a.id AND h.is_deleted = false AND h.status = 'active'
      WHERE a.data_type = ${dataType} AND a.is_deleted = false AND a.is_active = true
      ORDER BY a.name ASC
    `

    return { rows, total, assets }
  })

  app.get('/admin/prices/overview', async () => {
    // Per-data-type cache status - all read from unified asset_price_history
    const sections = await Promise.all(
      DATA_TYPES.map(async dataType => {
        const assets = await sql`
          SELECT
            a.id         AS asset_id,
            a.name,
            a.symbol,
            CASE
              WHEN p.price IS NOT NULL
              THEN ROUND(p.price::numeric / POWER(10, cur.decimals)::numeric, cur.decimals)::text
              ELSE NULL
            END AS price,
            p.recorded_at,
            CASE
              WHEN p.asset_id IS NULL                             THEN 'never'
              WHEN p.recorded_at < NOW() - INTERVAL '24 hours'   THEN 'stale'
              ELSE                                                     'fresh'
            END AS status
          FROM assets a
          JOIN currencies cur ON cur.code = a.currency
          JOIN holdings h ON h.asset_id = a.id AND h.status = 'active' AND h.is_deleted = false
          LEFT JOIN LATERAL (
            SELECT asset_id, price, recorded_at
            FROM asset_price_history
            WHERE asset_id = a.id
            ORDER BY price_date DESC
            LIMIT 1
          ) p ON true
          WHERE a.data_type = ${dataType}
            AND a.is_deleted = false
            AND a.is_active = true
          GROUP BY a.id, a.name, a.symbol, cur.decimals, p.price, p.recorded_at, p.asset_id
          ORDER BY a.name ASC
        `

        const fresh = assets.filter((r: any) => r.status === 'fresh').length
        const stale = assets.filter((r: any) => r.status === 'stale').length
        const never = assets.filter((r: any) => r.status === 'never').length

        return { data_type: dataType, assets, fresh_count: fresh, stale_count: stale, never_count: never }
      })
    )

    // Queue stats
    const queueStats = await sql`
      SELECT status, COUNT(*)::int AS count
      FROM price_fetch_queue
      GROUP BY status
    `
    const queueByStatus: Record<string, number> = {}
    for (const row of queueStats) queueByStatus[row.status] = row.count

    // Recent queue items (last 30, any status)
    const recentQueue = await sql`
      SELECT
        pq.id, pq.status, pq.priority, pq.retry_count,
        pq.queued_at, pq.completed_at, pq.error,
        a.name AS asset_name, a.symbol, a.data_type
      FROM price_fetch_queue pq
      JOIN assets a ON a.id = pq.asset_id
      ORDER BY pq.queued_at DESC
      LIMIT 30
    `

    // Recent PRICE_FETCH_FAILED alerts
    const alerts = await sql`
      SELECT id, type, payload, status, retry_count, created_at
      FROM notification_events
      WHERE type = 'PRICE_FETCH_FAILED'
      ORDER BY created_at DESC
      LIMIT 20
    `

    return {
      sections,
      queue: {
        pending:     queueByStatus['pending']     ?? 0,
        in_progress: queueByStatus['in_progress'] ?? 0,
        done:        queueByStatus['done']         ?? 0,
        failed:      queueByStatus['failed']       ?? 0,
        recent:      recentQueue,
      },
      alerts,
    }
  })
}
