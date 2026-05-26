import { FastifyInstance } from 'fastify'
import sql from '../db'
import { authenticate } from '../middleware/auth'
import { takeSnapshotForUser } from '../services/snapshots'
import { getRateSafe } from '../services/fx'
import { buildFamilySnapshotForDate } from '../services/snapshots/family'

export async function portfolioRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // GET /portfolio/snapshots
  // Returns all snapshots with entries, plus FX rates and base currency for the frontend to do conversions.
  app.get('/portfolio/snapshots', async (req, reply) => {
    const requesterId = req.user.id
    const { from, to, forUserId } = req.query as { from?: string; to?: string; forUserId?: string }

    const targetId = forUserId ?? requesterId
    if (forUserId && forUserId !== requesterId) {
      const { canViewUser } = await import('../routes/connections')
      const allowed = await canViewUser(requesterId, forUserId)
      if (!allowed) return reply.code(403).send({ error: 'Forbidden' })
    }

    const [user] = await sql`
      SELECT base_currency FROM users WHERE id = ${requesterId}
    `
    const baseCurrency = (user?.base_currency as string) ?? 'INR'

    const snapshots = await sql`
      WITH one_per_week AS (
        SELECT DISTINCT ON (DATE_TRUNC('week', s.snapshot_date))
               s.id, s.snapshot_date, s.source, s.portfolio_xirr
        FROM portfolio_snapshots s
        WHERE s.user_id = ${targetId}
          ${from ? sql`AND s.snapshot_date >= ${from}` : sql``}
          ${to ? sql`AND s.snapshot_date <= ${to}` : sql``}
        ORDER BY DATE_TRUNC('week', s.snapshot_date),
                 (SELECT COUNT(*) FROM portfolio_snapshot_entries WHERE snapshot_id = s.id) DESC,
                 (CASE WHEN s.source = 'cron' THEN 0 ELSE 1 END),
                 s.snapshot_date DESC
      )
      SELECT s.id, s.snapshot_date, s.source, s.portfolio_xirr,
             json_agg(
               json_build_object(
                 'id', e.id,
                 'holding_id', e.holding_id,
                 'asset_id', e.asset_id,
                 'asset_name', e.asset_name,
                 'asset_category', e.asset_category,
                 'currency', e.currency,
                 'quantity', e.quantity,
                 'price_per_unit_minor', e.price_per_unit_minor,
                 'value_minor', e.value_minor,
                 'xirr', e.xirr
               ) ORDER BY e.asset_category, e.asset_name
             ) AS entries
      FROM one_per_week s
      JOIN portfolio_snapshot_entries e ON e.snapshot_id = s.id
      GROUP BY s.id, s.snapshot_date, s.source, s.portfolio_xirr
      ORDER BY s.snapshot_date ASC
    `

    // Collect unique currencies used across all entries
    const allCurrencies = new Set<string>([baseCurrency])
    for (const snap of snapshots) {
      for (const e of (snap.entries as { currency: string }[])) {
        allCurrencies.add(e.currency)
      }
    }

    // Currency decimals
    const currencyRows = await sql`
      SELECT code, decimals FROM currencies WHERE code = ANY(${[...allCurrencies]})
    `
    const currencyDecimals: Record<string, number> = {}
    for (const row of currencyRows) {
      currencyDecimals[row.code as string] = row.decimals as number
    }

    // FX rates: foreign currency -> base currency
    const fxRates: Record<string, number> = {}
    for (const currency of allCurrencies) {
      if (currency === baseCurrency) continue
      const rateStr = await getRateSafe(currency, baseCurrency)
      if (rateStr) fxRates[currency] = parseFloat(rateStr)
    }

    return { snapshots, base_currency: baseCurrency, fx_rates: fxRates, currency_decimals: currencyDecimals }
  })

  // POST /portfolio/snapshots/trigger
  // Manually take a snapshot for today. Idempotent: no-op if snapshot already exists.
  app.post('/portfolio/snapshots/trigger', async (req, reply) => {
    const userId = req.user.id
    const today = new Date().toISOString().slice(0, 10)
    await takeSnapshotForUser(userId, today, 'cron')
    return reply.status(201).send({ ok: true, date: today })
  })

  // GET /portfolio/family/snapshots
  // Returns family aggregate snapshots for the caller's family group.
  // Returns 404 if the user has no family_id yet.
  app.get('/portfolio/family/snapshots', async (req, reply) => {
    const userId = req.user.id
    const { from, to } = req.query as { from?: string; to?: string }

    const [user] = await sql`
      SELECT base_currency, family_id::text AS family_id FROM users WHERE id = ${userId}
    `
    if (!user?.family_id) {
      return reply.code(404).send({ error: 'No family group found' })
    }

    const baseCurrency = (user.base_currency as string) ?? 'INR'
    const familyId = user.family_id as string

    const snapshots = await sql`
      SELECT s.id, s.snapshot_date, s.source, s.portfolio_xirr,
             json_agg(
               json_build_object(
                 'id', e.id,
                 'user_id', e.user_id,
                 'holding_id', e.holding_id,
                 'asset_id', e.asset_id,
                 'asset_name', e.asset_name,
                 'asset_category', e.asset_category,
                 'currency', e.currency,
                 'quantity', e.quantity,
                 'price_per_unit_minor', e.price_per_unit_minor,
                 'value_minor', e.value_minor,
                 'xirr', e.xirr
               ) ORDER BY e.asset_category, e.asset_name
             ) AS entries
      FROM family_portfolio_snapshots s
      JOIN family_portfolio_snapshot_entries e ON e.snapshot_id = s.id
      WHERE s.family_id = ${familyId}
        ${from ? sql`AND s.snapshot_date >= ${from}` : sql``}
        ${to ? sql`AND s.snapshot_date <= ${to}` : sql``}
      GROUP BY s.id, s.snapshot_date, s.source, s.portfolio_xirr
      ORDER BY s.snapshot_date ASC
    `

    const allCurrencies = new Set<string>([baseCurrency])
    for (const snap of snapshots) {
      for (const e of (snap.entries as { currency: string }[])) {
        allCurrencies.add(e.currency)
      }
    }

    const currencyRows = await sql`
      SELECT code, decimals FROM currencies WHERE code = ANY(${[...allCurrencies]})
    `
    const currencyDecimals: Record<string, number> = {}
    for (const row of currencyRows) {
      currencyDecimals[row.code as string] = row.decimals as number
    }

    const fxRates: Record<string, number> = {}
    for (const currency of allCurrencies) {
      if (currency === baseCurrency) continue
      const rateStr = await getRateSafe(currency, baseCurrency)
      if (rateStr) fxRates[currency] = parseFloat(rateStr)
    }

    return { snapshots, base_currency: baseCurrency, fx_rates: fxRates, currency_decimals: currencyDecimals }
  })

  // GET /portfolio/asset/:assetId/history
  // Returns per-week snapshot history for one asset plus value-weighted category XIRR for comparison.
  // ?family=true for family aggregate view, ?forUserId=<id> for a connected member.
  app.get('/portfolio/asset/:assetId/history', async (req, reply) => {
    const requesterId = req.user.id
    const { assetId } = req.params as { assetId: string }
    const { family, forUserId } = req.query as { family?: string; forUserId?: string }

    const [user] = await sql`
      SELECT base_currency, family_id::text AS family_id FROM users WHERE id = ${requesterId}
    `
    const baseCurrency = (user?.base_currency as string) ?? 'INR'
    const familyId = user?.family_id as string | null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let history: any[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let categoryHistory: any[] = []
    let assetCategory: string | null = null
    let assetCurrency: string | null = null

    if (family === 'true') {
      if (!familyId) return reply.code(404).send({ error: 'No family group found' })

      history = await sql`
        WITH one_per_week AS (
          SELECT DISTINCT ON (DATE_TRUNC('week', s.snapshot_date))
                 s.id, s.snapshot_date
          FROM family_portfolio_snapshots s
          WHERE s.family_id = ${familyId}
          ORDER BY DATE_TRUNC('week', s.snapshot_date), s.snapshot_date DESC
        )
        SELECT opw.snapshot_date, e.value_minor, e.xirr, e.quantity,
               e.currency, e.asset_name, e.asset_category
        FROM one_per_week opw
        JOIN family_portfolio_snapshot_entries e ON e.snapshot_id = opw.id
        WHERE e.asset_id = ${assetId}
        ORDER BY opw.snapshot_date ASC
      `
      if (history.length > 0) {
        assetCategory = history[0].asset_category as string
        assetCurrency = history[0].currency as string
        categoryHistory = await sql`
          WITH one_per_week AS (
            SELECT DISTINCT ON (DATE_TRUNC('week', s.snapshot_date))
                   s.id, s.snapshot_date
            FROM family_portfolio_snapshots s
            WHERE s.family_id = ${familyId}
            ORDER BY DATE_TRUNC('week', s.snapshot_date), s.snapshot_date DESC
          )
          SELECT opw.snapshot_date,
            SUM(e.value_minor::numeric * e.xirr) / NULLIF(SUM(e.value_minor::numeric), 0) AS category_xirr
          FROM one_per_week opw
          JOIN family_portfolio_snapshot_entries e ON e.snapshot_id = opw.id
          WHERE e.asset_category = ${assetCategory}
            AND e.xirr IS NOT NULL
          GROUP BY opw.snapshot_date
          ORDER BY opw.snapshot_date ASC
        `
      }
    } else {
      const targetId = forUserId ?? requesterId
      if (forUserId && forUserId !== requesterId) {
        const { canViewUser } = await import('../routes/connections')
        const allowed = await canViewUser(requesterId, forUserId)
        if (!allowed) return reply.code(403).send({ error: 'Forbidden' })
      }

      history = await sql`
        WITH one_per_week AS (
          SELECT DISTINCT ON (DATE_TRUNC('week', s.snapshot_date))
                 s.id, s.snapshot_date
          FROM portfolio_snapshots s
          WHERE s.user_id = ${targetId}
          ORDER BY DATE_TRUNC('week', s.snapshot_date), s.snapshot_date DESC
        )
        SELECT opw.snapshot_date, e.value_minor, e.xirr, e.quantity,
               e.currency, e.asset_name, e.asset_category
        FROM one_per_week opw
        JOIN portfolio_snapshot_entries e ON e.snapshot_id = opw.id
        WHERE e.asset_id = ${assetId}
        ORDER BY opw.snapshot_date ASC
      `
      if (history.length > 0) {
        assetCategory = history[0].asset_category as string
        assetCurrency = history[0].currency as string
        categoryHistory = await sql`
          WITH one_per_week AS (
            SELECT DISTINCT ON (DATE_TRUNC('week', s.snapshot_date))
                   s.id, s.snapshot_date
            FROM portfolio_snapshots s
            WHERE s.user_id = ${targetId}
            ORDER BY DATE_TRUNC('week', s.snapshot_date), s.snapshot_date DESC
          )
          SELECT opw.snapshot_date,
            SUM(e.value_minor::numeric * e.xirr) / NULLIF(SUM(e.value_minor::numeric), 0) AS category_xirr
          FROM one_per_week opw
          JOIN portfolio_snapshot_entries e ON e.snapshot_id = opw.id
          WHERE e.asset_category = ${assetCategory}
            AND e.xirr IS NOT NULL
          GROUP BY opw.snapshot_date
          ORDER BY opw.snapshot_date ASC
        `
      }
    }

    const currencies = [...new Set([baseCurrency, assetCurrency].filter(Boolean) as string[])]
    const currencyRows = await sql`SELECT code, decimals FROM currencies WHERE code = ANY(${currencies})`
    const currencyDecimals: Record<string, number> = {}
    for (const row of currencyRows) currencyDecimals[row.code as string] = row.decimals as number

    const fxRates: Record<string, number> = {}
    if (assetCurrency && assetCurrency !== baseCurrency) {
      const rateStr = await getRateSafe(assetCurrency, baseCurrency)
      if (rateStr) fxRates[assetCurrency] = parseFloat(rateStr)
    }

    const asset = history.length > 0
      ? { asset_name: history[0].asset_name, asset_category: history[0].asset_category, currency: history[0].currency }
      : null

    return { asset, history, categoryHistory, base_currency: baseCurrency, fx_rates: fxRates, currency_decimals: currencyDecimals }
  })

  // POST /portfolio/family/snapshots/trigger
  // Manually build a family snapshot for today.
  app.post('/portfolio/family/snapshots/trigger', async (req, reply) => {
    const userId = req.user.id
    const today = new Date().toISOString().slice(0, 10)

    const [user] = await sql`SELECT family_id::text AS family_id FROM users WHERE id = ${userId}`
    if (!user?.family_id) {
      return reply.code(404).send({ error: 'No family group found' })
    }

    await buildFamilySnapshotForDate(user.family_id as string, today)
    return reply.status(201).send({ ok: true, date: today })
  })
}
