import { logger } from '../../lib/logger'
import sql from '../../db'
import { resolveCorporateActions, fetchWeeklyPrices, fetchMfNavHistory, validateWeeklyPrices, validateMfNavHistory } from '../corporateActions'
import { CorporateAction, AssetAlias } from '../corporateActions/types'
import { WeeklyPrice } from '../corporateActions/yahoo'
import { MfNav } from '../corporateActions/mfapi'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AssetRow = {
  id: string
  symbol: string
  name: string
  currency: string
  data_type: string
  earliest_date: string  // YYYY-MM-DD, earliest lot date across all holdings
}

type PriceInsert = {
  price_date: string   // YYYY-MM-DD
  price: bigint        // minor units
  source: 'api'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveExchange(data_type: string): string {
  if (data_type === 'equity_india') return 'NSE'
  if (data_type === 'equity_us')    return 'US'
  return 'UNKNOWN'
}

function toMinorUnits(value: number, currency: string): bigint {
  // All currencies except JPY use 2 decimal places (100 minor units per major)
  const factor = currency === 'JPY' ? 1 : 100
  return BigInt(Math.round(value * factor))
}

// Generate all Fridays (YYYY-MM-DD) from startDate to today inclusive
function generateFridays(startDate: string): string[] {
  const fridays: string[] = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const d = new Date(startDate)
  // advance to first Friday on or after startDate
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1)

  while (d <= today) {
    fridays.push(d.toISOString().slice(0, 10))
    d.setDate(d.getDate() + 7)
  }
  return fridays
}

// For a target Friday, find the best available price from a daily price map
// Tries: Friday -> Thursday -> Wednesday -> Tuesday -> null
function resolvePriceForFriday(
  targetFriday: string,
  dailyMap: Map<string, number>
): number | null {
  const base = new Date(targetFriday)
  for (let daysBack = 0; daysBack <= 6; daysBack++) {
    const d = new Date(base)
    d.setDate(d.getDate() - daysBack)
    const key = d.toISOString().slice(0, 10)
    const price = dailyMap.get(key)
    if (price != null && price > 0) return price
  }
  return null
}

// ---------------------------------------------------------------------------
// DB reads
// ---------------------------------------------------------------------------

async function getAsset(assetId: string): Promise<AssetRow | null> {
  const [row] = await sql`
    SELECT
      a.id,
      a.symbol,
      a.name,
      a.currency,
      a.data_type,
      COALESCE(
        (
          SELECT MIN(l.transaction_date)::text
          FROM lots l
          JOIN holdings h ON h.id = l.holding_id
          WHERE h.asset_id = a.id
            AND l.is_deleted = false
            AND h.is_deleted = false
        ),
        (CURRENT_DATE - INTERVAL '1 year')::text
      ) AS earliest_date
    FROM assets a
    WHERE a.id = ${assetId}
      AND a.is_deleted = false
      AND a.update_mode = 'api'
  `
  return (row as AssetRow) ?? null
}

async function getMissingFridays(assetId: string, allFridays: string[]): Promise<string[]> {
  if (allFridays.length === 0) return []
  const existing = await sql<{ price_date: string }[]>`
    SELECT price_date::text AS price_date
    FROM asset_price_history
    WHERE asset_id = ${assetId}
      AND price_date = ANY(${allFridays}::date[])
  `
  const existingSet = new Set(existing.map(r => r.price_date))
  return allFridays.filter(f => !existingSet.has(f))
}

async function getActiveAlias(assetId: string, date: string): Promise<string | null> {
  const [row] = await sql`
    SELECT symbol FROM asset_aliases
    WHERE asset_id = ${assetId}
      AND from_date <= ${date}::date
      AND (to_date IS NULL OR to_date > ${date}::date)
    ORDER BY from_date DESC
    LIMIT 1
  `
  return row?.symbol ?? null
}

// ---------------------------------------------------------------------------
// DB writes
// ---------------------------------------------------------------------------

async function upsertAssetAliases(assetId: string, aliases: AssetAlias[]): Promise<void> {
  for (const a of aliases) {
    await sql`
      INSERT INTO asset_aliases (asset_id, symbol, name, from_date, to_date)
      VALUES (
        ${assetId},
        ${a.symbol},
        ${a.name},
        ${a.from_date}::date,
        ${a.to_date ? sql`${a.to_date}::date` : sql`NULL`}
      )
      ON CONFLICT DO NOTHING
    `
  }
}

async function upsertCorporateActions(assetId: string, actions: CorporateAction[]): Promise<void> {
  for (const a of actions) {
    await sql`
      INSERT INTO corporate_actions
        (asset_id, action_type, action_date, ratio_from, ratio_to, merged_into_asset_id, notes)
      VALUES (
        ${assetId},
        ${a.action_type},
        ${a.action_date}::date,
        ${a.ratio_from ?? null},
        ${a.ratio_to ?? null},
        NULL,
        ${a.notes ?? null}
      )
      ON CONFLICT DO NOTHING
    `
  }
}

async function upsertPrices(assetId: string, prices: PriceInsert[]): Promise<void> {
  if (prices.length === 0) return
  for (const p of prices) {
    await sql`
      INSERT INTO asset_price_history (asset_id, price_date, price, source)
      VALUES (${assetId}, ${p.price_date}::date, ${p.price.toString()}, ${p.source})
      ON CONFLICT (asset_id, price_date)
      DO UPDATE SET price = EXCLUDED.price, recorded_at = NOW()
    `
  }
}

// ---------------------------------------------------------------------------
// Main reconcile function - builds and inserts, never triggered
// ---------------------------------------------------------------------------

export async function reconcileAsset(assetId: string): Promise<void> {
  const asset = await getAsset(assetId)
  if (!asset) {
    logger.warn(`[reconcile] ${assetId}: not found or not eligible (inactive, deleted, or manual)`)
    return
  }

  if (!asset.symbol) {
    logger.warn(`[reconcile] ${asset.name}: no symbol set, skipping`)
    return
  }

  logger.info(`[reconcile] ${asset.symbol}: starting (earliest lot date: ${asset.earliest_date})`)

  // --- Step 1: resolve and persist corporate actions + aliases ---
  const caResult = await resolveCorporateActions({
    asset_id: assetId,
    symbol: asset.symbol,
    name: asset.name,
    exchange: deriveExchange(asset.data_type),
    data_type: asset.data_type,
    earliest_date: asset.earliest_date,
  })

  if (caResult.aliases.length > 0) {
    await upsertAssetAliases(assetId, caResult.aliases)
    logger.info(`[reconcile] ${asset.symbol}: ${caResult.aliases.length} alias(es) upserted`)
  }

  if (caResult.actions.length > 0) {
    await upsertCorporateActions(assetId, caResult.actions)
    logger.info(`[reconcile] ${asset.symbol}: ${caResult.actions.length} corporate action(s) upserted`)
  }

  // --- Step 2: find missing Fridays ---
  const allFridays = generateFridays(asset.earliest_date)
  const missing = await getMissingFridays(assetId, allFridays)

  if (missing.length === 0) {
    logger.info(`[reconcile] ${asset.symbol}: no missing Fridays`)
    return
  }

  logger.info(`[reconcile] ${asset.symbol}: ${missing.length} missing Friday(s) out of ${allFridays.length} total`)

  // --- Step 3: fetch prices and insert ---
  const prices: PriceInsert[] = []

  if (asset.data_type === 'equity_india' || asset.data_type === 'equity_us') {
    // For each missing Friday, we may need different symbols (pre/post name change)
    // Group missing Fridays by the symbol active at that date
    const symbolGroups = new Map<string, string[]>()

    for (const friday of missing) {
      const sym = (await getActiveAlias(assetId, friday)) ?? asset.symbol
      const group = symbolGroups.get(sym) ?? []
      group.push(friday)
      symbolGroups.set(sym, group)
    }

    for (const [sym, fridays] of symbolGroups) {
      logger.info(`[reconcile] ${asset.symbol}: fetching daily prices for symbol ${sym} (${fridays.length} target date(s))`)

      const rawPrices = await fetchWeeklyPrices(sym, deriveExchange(asset.data_type), asset.earliest_date)
      const validated = await validateWeeklyPrices(rawPrices, sym, 'reconciliation daily fetch')

      // Build a date -> close map for fast lookup
      const dailyMap = new Map<string, number>(validated.map(p => [p.price_date, p.close]))

      for (const friday of fridays) {
        const close = resolvePriceForFriday(friday, dailyMap)
        if (close == null) {
          logger.warn(`[reconcile] ${asset.symbol}: no price found for Friday ${friday} (symbol: ${sym})`)
          continue
        }
        prices.push({
          price_date: friday,
          price: toMinorUnits(close, asset.currency),
          source: 'api',
        })
      }
    }

  } else if (asset.data_type === 'mutual_fund_india') {
    const rawNavs = await fetchMfNavHistory(asset.symbol)
    const validated = await validateMfNavHistory(rawNavs, asset.symbol, 'reconciliation nav fetch')

    const dailyMap = new Map<string, number>(validated.map(n => [n.price_date, n.nav]))

    for (const friday of missing) {
      const nav = resolvePriceForFriday(friday, dailyMap)
      if (nav == null) {
        logger.warn(`[reconcile] ${asset.symbol}: no NAV found for Friday ${friday}`)
        continue
      }
      prices.push({
        price_date: friday,
        price: toMinorUnits(nav, asset.currency),
        source: 'api',
      })
    }
  }

  if (prices.length > 0) {
    await upsertPrices(assetId, prices)
    logger.info(`[reconcile] ${asset.symbol}: ${prices.length} price(s) inserted`)
  }

  logger.info(`[reconcile] ${asset.symbol}: done`)
}
