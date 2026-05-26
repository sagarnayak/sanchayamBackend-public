import { logger } from '../../lib/logger'
import sql from '../../db'
import { getPriceForDate } from '../prices'
import { getRateSafe } from '../fx'
import { CashFlow, computeReturn, trimLotsToCurrentPosition } from '../../lib/finance'
import { buildFamilySnapshotForDate } from './family'

interface SnapshotEntry {
  holding_id: string
  asset_id: string
  asset_name: string
  asset_category: string
  currency: string
  currency_decimals: number
  quantity: number
  price_per_unit_minor: number
  value_minor: number
  value_major: number
  xirr_val: number | null
}

export async function takeSnapshotsForAllUsers(source: 'cron' | 'import' = 'cron'): Promise<void> {
  const snapshotDate = new Date().toISOString().slice(0, 10)
  const users = await sql`
    SELECT id FROM users WHERE is_deleted = false AND is_master_admin = false
  `
  for (const user of users) {
    try {
      await takeSnapshotForUser(user.id, snapshotDate, source)
    } catch (err) {
      logger.error({ err }, `[snapshots] failed for user ${user.id}`)
    }
  }
}

export async function takeSnapshotForUser(userId: string, snapshotDate: string, source: 'cron' | 'import' = 'cron'): Promise<void> {
  const [existing] = await sql`
    SELECT id FROM portfolio_snapshots
    WHERE user_id = ${userId} AND snapshot_date = ${snapshotDate}
  `
  if (existing) {
    logger.info(`[snapshots] already exists for user ${userId} on ${snapshotDate}`)
    return
  }

  const [user] = await sql`
    SELECT u.base_currency, cur.decimals AS base_decimals, u.family_id::text AS family_id
    FROM users u
    JOIN currencies cur ON cur.code = u.base_currency
    WHERE u.id = ${userId}
  `
  if (!user) return

  const baseCurrency = user.base_currency as string
  const baseDecimals = user.base_decimals as number

  const holdings = await sql`
    SELECT h.id, h.asset_id, h.custom_name,
           a.name AS asset_name,
           COALESCE(a.data_type, 'other') AS asset_category,
           a.currency, a.update_mode, a.cost_basis_mode, a.data_type,
           a.locked_unit_cost,
           cur.decimals AS currency_decimals
    FROM holdings h
    JOIN assets a ON a.id = h.asset_id
    JOIN currencies cur ON cur.code = a.currency
    WHERE h.user_id = ${userId}
      AND h.is_deleted = false
      AND h.status = 'active'
  `

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type LotRow = any
  type HoldingResult = {
    holding_id: string; asset_id: string; asset_name: string; asset_category: string
    currency: string; currency_decimals: number; cost_basis_mode: string; data_type: string
    quantity: number; price_per_unit_minor: number; value_minor: number; value_major: number
    trimmedLots: LotRow[]
  }

  const holdingResults: HoldingResult[] = []

  for (const h of holdings) {
    const dec = h.currency_decimals as number
    const divisor = 10 ** dec

    let quantity = 0
    let valueMajor: number | null = null
    let pricePerUnitMinor = 0

    if (h.update_mode === 'api') {
      const [qtyRow] = await sql`
        SELECT
          COALESCE(SUM(CASE WHEN transaction_type = 'buy'  THEN quantity ELSE 0 END), 0) -
          COALESCE(SUM(CASE WHEN transaction_type = 'sell' THEN quantity ELSE 0 END), 0) AS qty
        FROM lots
        WHERE holding_id = ${h.id}
          AND transaction_date <= ${snapshotDate}
          AND is_deleted = false
      `
      quantity = parseFloat(qtyRow.qty)
      if (quantity <= 0) continue

      const priceData = await getPriceForDate(h.data_type, h.asset_id, snapshotDate)
      if (!priceData) continue

      const priceMajor = parseFloat(priceData.price)
      pricePerUnitMinor = Math.round(priceMajor * divisor)
      valueMajor = quantity * priceMajor

    } else if (h.update_mode === 'manual') {
      if (h.locked_unit_cost != null) {
        // locked-cost assets (e.g. bank_balance): point-in-time balance = buys - sells up to snapshotDate
        const lockedCost = parseFloat(h.locked_unit_cost)
        const [qtyRow] = await sql`
          SELECT
            COALESCE(SUM(CASE WHEN transaction_type = 'buy'  THEN quantity ELSE 0 END), 0) -
            COALESCE(SUM(CASE WHEN transaction_type = 'sell' THEN quantity ELSE 0 END), 0) AS qty
          FROM lots
          WHERE holding_id = ${h.id}
            AND transaction_date <= ${snapshotDate}
            AND is_deleted = false
        `
        quantity = parseFloat(qtyRow.qty)
        if (quantity <= 0) continue
        pricePerUnitMinor = Math.round(lockedCost * divisor)
        valueMajor = quantity * lockedCost
      } else {
        const [latest] = await sql`
          SELECT value FROM holding_values
          WHERE holding_id = ${h.id}
            AND recorded_at <= ${snapshotDate}::date + interval '1 day'
          ORDER BY recorded_at DESC LIMIT 1
        `
        if (!latest) continue

        const latestValueMinor = parseFloat(latest.value)
        valueMajor = latestValueMinor / divisor

        if (h.cost_basis_mode === 'fixed') {
          const [qtyRow] = await sql`
            SELECT
              COALESCE(SUM(CASE WHEN transaction_type = 'buy'  THEN quantity ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN transaction_type = 'sell' THEN quantity ELSE 0 END), 0) AS qty
            FROM lots
            WHERE holding_id = ${h.id}
              AND transaction_date <= ${snapshotDate}
              AND is_deleted = false
          `
          quantity = parseFloat(qtyRow.qty)
          if (quantity > 0) {
            pricePerUnitMinor = Math.round(latestValueMinor / quantity)
          } else {
            quantity = 1
            pricePerUnitMinor = Math.round(latestValueMinor)
          }
        } else {
          quantity = 1
          pricePerUnitMinor = Math.round(latestValueMinor)
        }
      }
    } else {
      continue
    }

    if (valueMajor === null || valueMajor <= 0) continue

    const valueMinor = Math.round(valueMajor * divisor)

    // Fetch and trim lots for XIRR - will be combined per asset_id after this loop
    let trimmedLots: LotRow[] = []
    if (h.cost_basis_mode === 'fixed' && h.data_type !== 'bank_balance') {
      const lots = await sql`
        SELECT transaction_type, quantity, price_per_unit, transaction_date
        FROM lots
        WHERE holding_id = ${h.id}
          AND is_deleted = false
          AND transaction_date <= ${snapshotDate}
        ORDER BY transaction_date ASC, created_at ASC
      `
      trimmedLots = trimLotsToCurrentPosition(lots) as LotRow[]
    }

    holdingResults.push({
      holding_id: h.id as string,
      asset_id: h.asset_id as string,
      asset_name: (h.custom_name ?? h.asset_name) as string,
      asset_category: h.asset_category as string,
      currency: h.currency as string,
      currency_decimals: dec,
      cost_basis_mode: h.cost_basis_mode as string,
      data_type: h.data_type as string,
      quantity,
      price_per_unit_minor: pricePerUnitMinor,
      value_minor: valueMinor,
      value_major: valueMajor,
      trimmedLots,
    })
  }

  // Aggregate holdings by asset_id: sum quantities/values, combine trimmed lots for XIRR
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  const entries: SnapshotEntry[] = []
  for (const [, agg] of assetMap.entries()) {
    const e = agg.rep
    const divisor = 10 ** e.currency_decimals
    let xirrVal: number | null = null

    if (agg.allTrimmedLots.length > 0) {
      const cashFlows: CashFlow[] = agg.allTrimmedLots.map(l => {
        const qty = parseFloat(l.quantity as string)
        const lotPriceMajor = parseFloat(l.price_per_unit as string) / divisor
        const amount = qty * lotPriceMajor
        return {
          amount: l.transaction_type === 'buy' ? -amount : +amount,
          date: new Date(l.transaction_date as string),
        }
      })
      cashFlows.push({ amount: agg.totalValueMajor, date: new Date(snapshotDate) })
      cashFlows.sort((a, b) => a.date.getTime() - b.date.getTime())
      xirrVal = computeReturn(cashFlows)
    }

    const combinedPricePerUnitMinor = agg.totalQty > 0
      ? Math.round(agg.totalValueMinor / agg.totalQty)
      : e.price_per_unit_minor

    entries.push({
      holding_id: e.holding_id,
      asset_id: e.asset_id,
      asset_name: e.asset_name,
      asset_category: e.asset_category,
      currency: e.currency,
      currency_decimals: e.currency_decimals,
      quantity: agg.totalQty,
      price_per_unit_minor: combinedPricePerUnitMinor,
      value_minor: agg.totalValueMinor,
      value_major: agg.totalValueMajor,
      xirr_val: xirrVal,
    })
  }

  if (entries.length === 0) {
    logger.info(`[snapshots] no entries for user ${userId} on ${snapshotDate}, skipping`)
    return
  }

  let portfolioXirr: number | null = null
  try {
    portfolioXirr = await computePortfolioXirr(userId, entries, baseCurrency, baseDecimals, snapshotDate)
  } catch (err) {
    logger.warn({ err }, `[snapshots] portfolio XIRR failed for user ${userId}`)
  }

  await sql.begin(async tx => {
    const [snap] = await tx`
      INSERT INTO portfolio_snapshots (user_id, snapshot_date, source, portfolio_xirr)
      VALUES (${userId}, ${snapshotDate}, ${source}, ${portfolioXirr ?? null})
      RETURNING id
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

  logger.info(`[snapshots] user ${userId} on ${snapshotDate}: ${entries.length} entries, portfolio XIRR: ${portfolioXirr?.toFixed(4) ?? 'n/a'}`)

  // If the user belongs to a family, rebuild the family snapshot for this date
  if (user.family_id) {
    buildFamilySnapshotForDate(user.family_id as string, snapshotDate).catch(err => {
      logger.error({ err }, `[snapshots] family snapshot update failed for family ${user.family_id} on ${snapshotDate}`)
    })
  }
}

async function computePortfolioXirr(
  userId: string,
  entries: SnapshotEntry[],
  baseCurrency: string,
  baseDecimals: number,
  snapshotDate: string
): Promise<number | null> {
  const lots = await sql`
    SELECT l.holding_id, l.transaction_type, l.quantity, l.price_per_unit, l.transaction_date,
           a.currency, cur.decimals
    FROM lots l
    JOIN holdings h ON h.id = l.holding_id
    JOIN assets a ON a.id = h.asset_id
    JOIN currencies cur ON cur.code = a.currency
    WHERE h.user_id = ${userId}
      AND h.is_deleted = false
      AND a.cost_basis_mode = 'fixed'
      AND a.data_type != 'bank_balance'
      AND l.is_deleted = false
      AND l.transaction_date <= ${snapshotDate}
    ORDER BY l.transaction_date ASC, l.created_at ASC
  `

  if (lots.length === 0) return null

  const fxCache = new Map<string, number>()
  async function getFxRate(currency: string): Promise<number | null> {
    if (currency === baseCurrency) return 1
    if (fxCache.has(currency)) return fxCache.get(currency)!
    const rateStr = await getRateSafe(currency, baseCurrency)
    if (!rateStr) return null
    const rate = parseFloat(rateStr)
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
      const qty = parseFloat(lot.quantity)
      const priceMajor = parseFloat(lot.price_per_unit) / assetDivisor
      const amountInAsset = qty * priceMajor
      const rate = await getFxRate(lot.currency)
      if (rate === null) continue
      const amountInBase = amountInAsset * rate
      cashFlows.push({
        amount: lot.transaction_type === 'buy' ? -amountInBase : +amountInBase,
        date: new Date(lot.transaction_date)
      })
    }
  }

  let totalBaseValueMajor = 0
  for (const entry of entries) {
    const entryDivisor = 10 ** entry.currency_decimals
    const valueMajor = entry.value_minor / entryDivisor
    if (entry.currency === baseCurrency) {
      totalBaseValueMajor += valueMajor
    } else {
      const rate = await getFxRate(entry.currency)
      totalBaseValueMajor += valueMajor * (rate ?? 1)
    }
  }

  if (totalBaseValueMajor <= 0) return null

  cashFlows.push({ amount: totalBaseValueMajor, date: new Date(snapshotDate) })

  return computeReturn(cashFlows)
}
