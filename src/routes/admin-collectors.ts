import { logger } from '../lib/logger'
import { FastifyInstance } from 'fastify'
import sql from '../db'
import { requireAdmin } from '../middleware/auth'
import { runHistoricalSnapshotBackfill } from '../services/snapshots/backfill'

export async function adminCollectorsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/admin/collectors/backfill-stats', async () => {
    const [eligible] = await sql`
      SELECT COUNT(DISTINCT h.asset_id)::int AS total
      FROM holdings h
      JOIN assets a ON a.id = h.asset_id
      WHERE h.is_deleted = false
        AND h.status = 'active'
        AND a.update_mode = 'api'
        AND a.is_deleted = false
    `

    const [withHistory] = await sql`
      SELECT COUNT(DISTINCT asset_id)::int AS total
      FROM asset_price_history
      WHERE price_date < CURRENT_DATE - INTERVAL '30 days'
    `

    const [pricePoints] = await sql`
      SELECT COUNT(*)::int AS total FROM asset_price_history
    `

    const [corporateActions] = await sql`
      SELECT COUNT(*)::int AS total FROM corporate_actions
    `

    const [aliases] = await sql`
      SELECT COUNT(*)::int AS total FROM asset_aliases
    `

    const [dateRange] = await sql`
      SELECT
        MIN(price_date)::text AS oldest,
        MAX(price_date)::text AS newest
      FROM asset_price_history
    `

    const queueStats = await sql`
      SELECT stage, status, COUNT(*)::int AS cnt
      FROM backfill_queue
      GROUP BY stage, status
    `

    type QueueRow = { stage: string; status: string; cnt: number }
    const queue: Record<string, Record<string, number>> = {}
    for (const row of queueStats as unknown as QueueRow[]) {
      if (!queue[row.stage]) queue[row.stage] = {}
      queue[row.stage][row.status] = row.cnt
    }

    // Snapshot backfill stats
    const [snapTotal] = await sql`
      SELECT COUNT(*)::int AS total FROM portfolio_snapshots WHERE source = 'import'
    `
    const [snapDateRange] = await sql`
      SELECT MIN(snapshot_date)::text AS oldest, MAX(snapshot_date)::text AS newest
      FROM portfolio_snapshots WHERE source = 'import'
    `
    const [snapPending] = await sql`
      WITH eligible_assets AS (
        SELECT DISTINCT bq.asset_id FROM backfill_queue bq
        WHERE bq.stage = 'splits' AND bq.status = 'done'
      ),
      available_fridays AS (
        SELECT DISTINCT aph.asset_id, aph.price_date
        FROM asset_price_history aph
        WHERE aph.asset_id IN (SELECT asset_id FROM eligible_assets)
          AND aph.price_date < CURRENT_DATE
      ),
      user_holdings AS (
        SELECT DISTINCT h.user_id, h.asset_id FROM holdings h
        JOIN assets a ON a.id = h.asset_id
        WHERE h.is_deleted = false AND h.status = 'active'
          AND a.update_mode = 'api' AND a.is_deleted = false AND a.is_active = true
      )
      SELECT COUNT(DISTINCT (uh.user_id, af.price_date))::int AS pending
      FROM user_holdings uh
      JOIN available_fridays af ON af.asset_id = uh.asset_id
      WHERE NOT EXISTS (
        SELECT 1 FROM portfolio_snapshots ps
        WHERE ps.user_id = uh.user_id AND ps.snapshot_date = af.price_date
      )
    `
    const [snapUsers] = await sql`
      SELECT COUNT(DISTINCT user_id)::int AS total FROM portfolio_snapshots WHERE source = 'import'
    `
    const [snapLastRun] = await sql`
      SELECT MAX(created_at) AS last_run FROM portfolio_snapshots WHERE source = 'import'
    `

    const totalEligible = eligible.total as number
    const assetsWithHistory = withHistory.total as number

    return {
      total_eligible_assets:   totalEligible,
      assets_with_history:     assetsWithHistory,
      assets_pending:          totalEligible - assetsWithHistory,
      total_price_points:      pricePoints.total,
      total_corporate_actions: corporateActions.total,
      total_aliases:           aliases.total,
      oldest_price_date:       dateRange?.oldest ?? null,
      newest_price_date:       dateRange?.newest ?? null,
      queue,
      snapshots: {
        total:       snapTotal.total        as number,
        pending:     snapPending.pending    as number,
        users:       snapUsers.total        as number,
        oldest_date: snapDateRange?.oldest  ?? null,
        newest_date: snapDateRange?.newest  ?? null,
        last_run:    snapLastRun?.last_run  ?? null,
      },
    }
  })

  app.get('/admin/collectors/overview', async () => {
    const collectors = await sql`
      SELECT name, base_url, rate_limit_per_min, is_active,
             length(api_key_enc) > 0 AS key_configured
      FROM data_collectors
      ORDER BY name
    `

    const capabilities = await sql`
      SELECT collector_name, data_type, symbol
      FROM provider_routing
      WHERE is_active = true
      UNION ALL
      SELECT collector_name, 'fx_rate' AS data_type, NULL AS symbol
      FROM currency_collector_map
      GROUP BY collector_name
      ORDER BY collector_name, data_type
    `

    // 7-day aggregate stats per collector
    const stats = await sql`
      SELECT
        collector_name,
        COUNT(*)::int                                            AS calls_7d,
        COUNT(*) FILTER (WHERE success = true)::int             AS success_7d,
        COUNT(*) FILTER (WHERE success = false)::int            AS failed_7d,
        MAX(called_at)                                          AS last_called_at
      FROM collector_call_log
      WHERE called_at > NOW() - INTERVAL '7 days'
      GROUP BY collector_name
    `

    // last 5 calls per collector (window function)
    const recentCalls = await sql`
      SELECT collector_name, success, items_requested, items_returned, error_message, called_at
      FROM (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY collector_name ORDER BY called_at DESC) AS rn
        FROM collector_call_log
      ) ranked
      WHERE rn <= 5
      ORDER BY collector_name, called_at ASC
    `

    // failure alerts in last 7 days, counted per collector via call log failures
    const alertRows = await sql`
      SELECT collector_name, COUNT(*)::int AS count
      FROM collector_call_log
      WHERE success = false
        AND called_at > NOW() - INTERVAL '7 days'
      GROUP BY collector_name
    `
    const alertMap = new Map<string, number>()
    for (const row of alertRows) {
      alertMap.set(row.collector_name as string, row.count as number)
    }

    // group everything by collector name
    type CapEntry  = { data_type: string; symbol: string | null }
    type StatRow   = typeof stats[number]
    type CallRow   = typeof recentCalls[number]
    const capMap   = new Map<string, CapEntry[]>()
    const statsMap = new Map<string, StatRow>()
    const callsMap = new Map<string, CallRow[]>()

    for (const cap of capabilities) {
      const list = capMap.get(cap.collector_name) ?? []
      list.push({ data_type: cap.data_type, symbol: cap.symbol })
      capMap.set(cap.collector_name, list)
    }
    for (const s of stats) {
      statsMap.set(s.collector_name as string, s)
    }
    for (const c of recentCalls) {
      const key  = c.collector_name as string
      const list = callsMap.get(key) ?? ([] as CallRow[])
      list.push(c)
      callsMap.set(key, list)
    }

    return {
      collectors: collectors.map(c => {
        const s = statsMap.get(c.name as string)
        return {
          ...c,
          capabilities: capMap.get(c.name as string) ?? [],
          stats: {
            calls_7d:          s?.calls_7d ?? 0,
            success_7d:        s?.success_7d ?? 0,
            failed_7d:         s?.failed_7d ?? 0,
            last_called_at:    s?.last_called_at ?? null,
            recent_calls:      callsMap.get(c.name as string) ?? [],
            failure_alerts_7d: alertMap.get(c.name as string) ?? 0,
          },
        }
      }),
    }
  })

  app.post('/admin/collectors/run-snapshot-backfill', async () => {
    runHistoricalSnapshotBackfill().catch(err => {
      logger.error({ err }, '[snapshot-backfill] manual trigger error:')
    })
    return { started: true }
  })

}
