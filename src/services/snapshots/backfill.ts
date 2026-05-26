import { logger } from '../../lib/logger'
import sql from '../../db'
import { computeReturn, CashFlow, trimLotsToCurrentPosition } from '../../lib/finance'
import { getRateSafe } from '../fx'

const CONCURRENCY = 10

// ---------------------------------------------------------------------------
// Worker pool - fires `concurrency` workers that each drain a shared queue
// ---------------------------------------------------------------------------
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items]
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift()!
      try {
        await fn(item)
      } catch (err) {
        logger.error({ err }, '[snapshot-backfill] error:')
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
}

// ---------------------------------------------------------------------------
// Step 1: find all (userId, weekFriday) pairs that need a historical snapshot
//
// Candidate weeks: one per DATE_TRUNC('week') that has any price data for any
// eligible asset. The representative date stored as snapshot_date is the Friday
// of that week (week_anchor + 4 days), matching the purge's week boundary.
//
// No strict all-assets gate here - the 50% rule in takeHistoricalSnapshot()
// handles weeks with insufficient coverage.
// ---------------------------------------------------------------------------
async function findSnapshotWork(): Promise<Array<{ userId: string; friday: string }>> {
  const rows = await sql`
    WITH eligible_assets AS (
      SELECT DISTINCT bq.asset_id
      FROM backfill_queue bq
      WHERE bq.stage = 'splits'
        AND bq.status = 'done'
    ),
    user_holdings AS (
      SELECT DISTINCT h.user_id, h.asset_id
      FROM holdings h
      JOIN assets a ON a.id = h.asset_id
      WHERE h.is_deleted = false
        AND h.status IN ('active', 'exited')
        AND a.update_mode = 'api'
        AND a.is_deleted = false
        AND h.asset_id IN (SELECT asset_id FROM eligible_assets)
    ),
    candidate_weeks AS (
      -- One Friday per week that has any price data for any eligible asset
      SELECT DISTINCT
        (DATE_TRUNC('week', price_date) + INTERVAL '4 days')::date AS friday
      FROM asset_price_history
      WHERE asset_id IN (SELECT asset_id FROM eligible_assets)
        AND price_date < CURRENT_DATE
    )
    SELECT DISTINCT uh.user_id::text, cw.friday::text
    FROM user_holdings uh
    CROSS JOIN candidate_weeks cw
    WHERE NOT EXISTS (
      SELECT 1 FROM portfolio_snapshots ps
      WHERE ps.user_id      = uh.user_id
        AND ps.snapshot_date = cw.friday
    )
    ORDER BY cw.friday::text ASC
  `

  return rows.map(r => ({ userId: r.user_id as string, friday: r.friday as string }))
}

// ---------------------------------------------------------------------------
// Step 2: generate one historical snapshot for a single (userId, friday)
// ---------------------------------------------------------------------------
async function takeHistoricalSnapshot(userId: string, friday: string): Promise<void> {
  // Try to claim this (user, date) slot - ON CONFLICT DO NOTHING handles races
  const [snap] = await sql`
    INSERT INTO portfolio_snapshots (user_id, snapshot_date, source)
    VALUES (${userId}, ${friday}::date, 'import')
    ON CONFLICT (user_id, snapshot_date) DO NOTHING
    RETURNING id
  `
  if (!snap?.id) return  // another worker already wrote this slot

  const [user] = await sql`
    SELECT u.base_currency, cur.decimals AS base_decimals
    FROM users u
    JOIN currencies cur ON cur.code = u.base_currency
    WHERE u.id = ${userId}
  `
  if (!user) return

  const baseCurrency = user.base_currency as string
  const baseDecimals = user.base_decimals as number

  // All holdings for this user (active or exited) - all update modes
  const holdings = await sql`
    SELECT h.id AS holding_id, h.asset_id,
           COALESCE(h.custom_name, a.name) AS asset_name,
           COALESCE(a.data_type, 'other')  AS asset_category,
           a.currency, a.cost_basis_mode, a.update_mode, a.locked_unit_cost,
           cur.decimals AS currency_decimals
    FROM holdings h
    JOIN assets a   ON a.id = h.asset_id
    JOIN currencies cur ON cur.code = a.currency
    WHERE h.user_id    = ${userId}
      AND h.is_deleted = false
      AND h.status     IN ('active', 'exited')
      AND a.is_deleted = false
  `

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type LotRow = any
  type HoldingResult = {
    holding_id: string; asset_id: string; asset_name: string; asset_category: string
    currency: string; currency_decimals: number; cost_basis_mode: string
    quantity: number; price_per_unit_minor: number; value_minor: number; value_major: number
    trimmedLots: LotRow[]
  }

  const holdingResults: HoldingResult[] = []

  for (const h of holdings) {
    const dec     = h.currency_decimals as number
    const divisor = 10 ** dec

    let priceMinor = 0
    let quantity   = 0
    let valueMajor = 0

    if (h.update_mode === 'api') {
      // Price: latest price on or before this Friday's week (carry-forward from prior weeks)
      const [priceRow] = await sql`
        SELECT price FROM asset_price_history
        WHERE asset_id  = ${h.asset_id}
          AND DATE_TRUNC('week', price_date) <= DATE_TRUNC('week', ${friday}::date)
          AND price > 0
        ORDER BY price_date DESC
        LIMIT 1
      `
      if (!priceRow) continue

      priceMinor = parseFloat(priceRow.price as string)
      const priceMajor = priceMinor / divisor

      const [qtyRow] = await sql`
        SELECT COALESCE(SUM(
          CASE WHEN l.transaction_type = 'buy'  THEN  l.quantity::numeric
               WHEN l.transaction_type = 'sell' THEN -l.quantity::numeric
               ELSE 0 END
        ), 0) AS qty
        FROM lots l
        WHERE l.holding_id       = ${h.holding_id}
          AND l.transaction_date <= ${friday}::date
          AND l.is_deleted       = false
      `
      quantity = parseFloat(qtyRow.qty as string)
      if (quantity <= 0) continue

      valueMajor = quantity * priceMajor

    } else if (h.update_mode === 'manual') {
      if (h.locked_unit_cost != null) {
        // Locked-cost asset (e.g. bank_balance): balance = buys - sells up to this date
        const lockedCost = parseFloat(h.locked_unit_cost as string)
        const [qtyRow] = await sql`
          SELECT COALESCE(SUM(
            CASE WHEN l.transaction_type = 'buy'  THEN  l.quantity::numeric
                 WHEN l.transaction_type = 'sell' THEN -l.quantity::numeric
                 ELSE 0 END
          ), 0) AS qty
          FROM lots l
          WHERE l.holding_id       = ${h.holding_id}
            AND l.transaction_date <= ${friday}::date
            AND l.is_deleted       = false
        `
        quantity = parseFloat(qtyRow.qty as string)
        if (quantity <= 0) continue

        priceMinor = Math.round(lockedCost * divisor)
        valueMajor = quantity * lockedCost

      } else {
        // Manual value asset (e.g. manually updated MF): use latest recorded value on or before this date
        const [latest] = await sql`
          SELECT value FROM holding_values
          WHERE holding_id = ${h.holding_id}
            AND recorded_at <= ${friday}::date + interval '1 day'
          ORDER BY recorded_at DESC LIMIT 1
        `
        if (!latest) continue

        const latestValueMinor = parseFloat(latest.value as string)
        valueMajor = latestValueMinor / divisor

        const [qtyRow] = await sql`
          SELECT COALESCE(SUM(
            CASE WHEN l.transaction_type = 'buy'  THEN  l.quantity::numeric
                 WHEN l.transaction_type = 'sell' THEN -l.quantity::numeric
                 ELSE 0 END
          ), 0) AS qty
          FROM lots l
          WHERE l.holding_id       = ${h.holding_id}
            AND l.transaction_date <= ${friday}::date
            AND l.is_deleted       = false
        `
        const q = parseFloat(qtyRow.qty as string)
        if (q > 0) {
          quantity   = q
          priceMinor = Math.round(latestValueMinor / q)
        } else {
          quantity   = 1
          priceMinor = Math.round(latestValueMinor)
        }
      }
    } else {
      continue
    }

    const valueMinor = Math.round(valueMajor * divisor)

    // Fetch and trim lots for XIRR - will be combined per asset_id after this loop
    let trimmedLots: LotRow[] = []
    if (h.cost_basis_mode === 'fixed') {
      const lots = await sql`
        SELECT transaction_type, quantity, price_per_unit, transaction_date
        FROM lots
        WHERE holding_id       = ${h.holding_id}
          AND transaction_date <= ${friday}::date
          AND is_deleted       = false
        ORDER BY transaction_date ASC, created_at ASC
      `
      trimmedLots = trimLotsToCurrentPosition(lots) as LotRow[]
    }

    holdingResults.push({
      holding_id:           h.holding_id as string,
      asset_id:             h.asset_id as string,
      asset_name:           h.asset_name as string,
      asset_category:       h.asset_category as string,
      currency:             h.currency as string,
      currency_decimals:    dec,
      cost_basis_mode:      h.cost_basis_mode as string,
      quantity,
      price_per_unit_minor: priceMinor,
      value_minor:          valueMinor,
      value_major:          valueMajor,
      trimmedLots,
    })
  }

  // Aggregate holdings by asset_id: sum quantities/values, combine trimmed lots for XIRR
  const assetMap = new Map<string, {
    rep: HoldingResult
    totalQty: number
    totalValueMinor: number
    totalValueMajor: number
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    allTrimmedLots: any[]
  }>()
  for (const hr of holdingResults) {
    const existing = assetMap.get(hr.asset_id)
    if (!existing) {
      assetMap.set(hr.asset_id, {
        rep: hr,
        totalQty: hr.quantity,
        totalValueMinor: hr.value_minor,
        totalValueMajor: hr.value_major,
        allTrimmedLots: [...hr.trimmedLots],
      })
    } else {
      existing.totalQty += hr.quantity
      existing.totalValueMinor += hr.value_minor
      existing.totalValueMajor += hr.value_major
      existing.allTrimmedLots.push(...hr.trimmedLots)
    }
  }

  // Build final entries with one row per asset_id and combined XIRR
  type Entry = {
    holding_id: string; asset_id: string; asset_name: string; asset_category: string
    currency: string; currency_decimals: number
    quantity: number; price_per_unit_minor: number; value_minor: number; value_major: number
    xirr_val: number | null
  }
  const entries: Entry[] = []
  for (const [, agg] of assetMap.entries()) {
    const e = agg.rep
    const divisor = 10 ** e.currency_decimals
    let xirrVal: number | null = null

    if (agg.allTrimmedLots.length > 0) {
      const cashFlows: CashFlow[] = agg.allTrimmedLots.map(l => {
        const qty           = parseFloat(l.quantity as string)
        const lotPriceMajor = parseFloat(l.price_per_unit as string) / divisor
        const amount        = qty * lotPriceMajor
        return {
          amount: l.transaction_type === 'buy' ? -amount : +amount,
          date: new Date(l.transaction_date as string),
        }
      })
      cashFlows.push({ amount: agg.totalValueMajor, date: new Date(friday) })
      cashFlows.sort((a, b) => a.date.getTime() - b.date.getTime())
      xirrVal = computeReturn(cashFlows)
    }

    const combinedPricePerUnitMinor = agg.totalQty > 0
      ? Math.round(agg.totalValueMinor / agg.totalQty)
      : e.price_per_unit_minor

    entries.push({
      holding_id:           e.holding_id,
      asset_id:             e.asset_id,
      asset_name:           e.asset_name,
      asset_category:       e.asset_category,
      currency:             e.currency,
      currency_decimals:    e.currency_decimals,
      quantity:             agg.totalQty,
      price_per_unit_minor: combinedPricePerUnitMinor,
      value_minor:          agg.totalValueMinor,
      value_major:          agg.totalValueMajor,
      xirr_val:             xirrVal,
    })
  }

  // 50% rule: if more than half of holdings that existed at this date have no data, skip.
  // Use holdings-with-lots as denominator (not all current holdings) to avoid rejecting
  // legitimate historical snapshots where the user had fewer holdings in the past.
  const [activeThenRow] = await sql`
    SELECT COUNT(DISTINCT h.id)::int AS cnt
    FROM holdings h
    WHERE h.user_id    = ${userId}
      AND h.is_deleted = false
      AND h.status     IN ('active', 'exited')
      AND (
        SELECT COALESCE(SUM(
          CASE WHEN l.transaction_type = 'buy'  THEN  l.quantity::numeric
               WHEN l.transaction_type = 'sell' THEN -l.quantity::numeric
               ELSE 0 END
        ), 0)
        FROM lots l
        WHERE l.holding_id       = h.id
          AND l.transaction_date <= ${friday}::date
          AND l.is_deleted       = false
      ) > 0
  `
  const activeThen = (activeThenRow?.cnt as number) ?? 0
  if (holdingResults.length === 0 || (activeThen > 0 && holdingResults.length < activeThen / 2)) {
    await sql`DELETE FROM portfolio_snapshots WHERE id = ${snap.id}`
    return
  }

  // Portfolio XIRR
  let portfolioXirr: number | null = null
  try {
    const raw = await computeHistoricalPortfolioXirr(userId, entries, baseCurrency, baseDecimals, friday)
    portfolioXirr = raw !== null && Math.abs(raw) < 9999 ? raw : null
  } catch { /* non-fatal */ }

  // Persist entries + update portfolio_xirr in one transaction
  await sql.begin(async tx => {
    await tx`
      UPDATE portfolio_snapshots SET portfolio_xirr = ${portfolioXirr ?? null}
      WHERE id = ${snap.id}
    `
    for (const e of entries) {
      await tx`
        INSERT INTO portfolio_snapshot_entries (
          snapshot_id, holding_id, asset_id, asset_name, asset_category,
          currency, quantity, price_per_unit_minor, value_minor, xirr
        ) VALUES (
          ${snap.id}, ${e.holding_id}, ${e.asset_id}, ${e.asset_name}, ${e.asset_category},
          ${e.currency}, ${e.quantity.toString()}, ${e.price_per_unit_minor.toString()},
          ${e.value_minor.toString()}, ${e.xirr_val ?? null}
        )
      `
    }
  })
}

async function computeHistoricalPortfolioXirr(
  userId: string,
  entries: Array<{ currency: string; currency_decimals: number; value_minor: number }>,
  baseCurrency: string,
  baseDecimals: number,
  friday: string,
): Promise<number | null> {
  const baseDivisor = 10 ** baseDecimals

  const lots = await sql`
    SELECT l.holding_id, l.transaction_type, l.quantity, l.price_per_unit, l.transaction_date,
           a.currency, cur.decimals
    FROM lots l
    JOIN holdings h  ON h.id = l.holding_id
    JOIN assets a    ON a.id = h.asset_id
    JOIN currencies cur ON cur.code = a.currency
    WHERE h.user_id          = ${userId}
      AND h.is_deleted       = false
      AND a.cost_basis_mode  = 'fixed'
      AND a.data_type != 'bank_balance'
      AND l.is_deleted       = false
      AND l.transaction_date <= ${friday}::date
    ORDER BY l.transaction_date ASC, l.created_at ASC
  `
  if (lots.length === 0) return null

  const fxCache = new Map<string, number>()
  async function getFx(currency: string): Promise<number | null> {
    if (currency === baseCurrency) return 1
    if (fxCache.has(currency)) return fxCache.get(currency)!
    const r = await getRateSafe(currency, baseCurrency)
    if (!r) return null
    const rate = parseFloat(r)
    fxCache.set(currency, rate)
    return rate
  }

  // Group by holding, trim each to current position, then flatten
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byHolding = new Map<string, any[]>()
  for (const lot of lots) {
    const hid = lot.holding_id as string
    if (!byHolding.has(hid)) byHolding.set(hid, [])
    byHolding.get(hid)!.push(lot)
  }

  const cashFlows: CashFlow[] = []
  for (const holdingLots of byHolding.values()) {
    const effectiveLots = trimLotsToCurrentPosition(holdingLots)
    for (const lot of effectiveLots) {
      const assetDivisor = 10 ** (lot.decimals as number)
      const qty          = parseFloat(lot.quantity as string)
      const priceMajor   = parseFloat(lot.price_per_unit as string) / assetDivisor
      const amount       = qty * priceMajor
      const rate         = await getFx(lot.currency as string)
      if (rate === null) continue
      cashFlows.push({
        amount: lot.transaction_type === 'buy' ? -(amount * rate) : +(amount * rate),
        date: new Date(lot.transaction_date as string),
      })
    }
  }

  let totalBaseValue = 0
  for (const e of entries) {
    const d       = 10 ** e.currency_decimals
    const major   = e.value_minor / d
    const rate    = await getFx(e.currency)
    totalBaseValue += major * (rate ?? 1)
  }

  if (totalBaseValue <= 0) return null

  cashFlows.push({ amount: totalBaseValue, date: new Date(friday) })
  cashFlows.sort((a, b) => a.date.getTime() - b.date.getTime())

  void baseDivisor
  return computeReturn(cashFlows)
}

// ---------------------------------------------------------------------------
// Public entry point - called by the Saturday cron and by the backfill worker
// when an asset completes its prices stage.
// ---------------------------------------------------------------------------
export async function runHistoricalSnapshotBackfill(): Promise<void> {
  logger.info('[snapshot-backfill] finding eligible (user, friday) pairs...')
  const work = await findSnapshotWork()

  if (work.length === 0) {
    logger.info('[snapshot-backfill] nothing to do')
    return
  }

  logger.info(`[snapshot-backfill] ${work.length} snapshot(s) to generate (concurrency=${CONCURRENCY})`)

  let done = 0
  await runWithConcurrency(work, CONCURRENCY, async item => {
    await takeHistoricalSnapshot(item.userId, item.friday)
    done++
    if (done % 50 === 0) {
      logger.info(`[snapshot-backfill] progress: ${done}/${work.length}`)
    }
  })

  logger.info(`[snapshot-backfill] complete: ${done}/${work.length} processed`)
}
