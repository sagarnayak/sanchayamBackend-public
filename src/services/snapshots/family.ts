import { logger } from '../../lib/logger'
import sql from '../../db'
import { CashFlow, computeReturn, trimLotsToCurrentPosition } from '../../lib/finance'
import { getRateSafe } from '../fx'

const CONCURRENCY = 10

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items]
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift()!
      try { await fn(item) }
      catch (err) { logger.error({ err }, '[family-snapshots] error:') }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
}

// A user is included in family snapshots if they have at least one active connection
// with include_in_family = true. Disconnected members and explicitly excluded members
// (include_in_family = false) are not included.
async function getIncludedMembers(
  familyId: string,
): Promise<Array<{ id: string; base_currency: string; base_decimals: number }>> {
  const rows = await sql`
    SELECT u.id::text, u.base_currency, cur.decimals AS base_decimals
    FROM users u
    JOIN currencies cur ON cur.code = u.base_currency
    WHERE u.family_id = ${familyId}
      AND u.is_deleted = false
      AND EXISTS (
        SELECT 1 FROM family_connections fc
        WHERE (fc.requester_id = u.id OR fc.owner_id = u.id)
          AND fc.status = 'active'
          AND fc.include_in_family = true
      )
  `
  return rows as unknown as Array<{ id: string; base_currency: string; base_decimals: number }>
}

type FamilyEntry = {
  user_id: string
  holding_id: string
  asset_id: string
  asset_name: string
  asset_category: string
  currency: string
  currency_decimals: number
  quantity: string
  price_per_unit_minor: string
  value_minor: string
  xirr: string | null
}

async function computeFamilyPortfolioXirr(
  userIds: string[],
  entries: FamilyEntry[],
  refCurrency: string,
  date: string,
): Promise<number | null> {
  const lots = await sql`
    SELECT l.holding_id, l.transaction_type, l.quantity, l.price_per_unit, l.transaction_date,
           a.currency, cur.decimals
    FROM lots l
    JOIN holdings h ON h.id = l.holding_id
    JOIN assets a ON a.id = h.asset_id
    JOIN currencies cur ON cur.code = a.currency
    WHERE h.user_id = ANY(${userIds}::uuid[])
      AND h.is_deleted = false
      AND a.cost_basis_mode = 'fixed'
      AND a.data_type != 'bank_balance'
      AND l.is_deleted = false
      AND l.transaction_date <= ${date}::date
    ORDER BY l.transaction_date ASC, l.created_at ASC
  `
  if (lots.length === 0) return null

  const fxCache = new Map<string, number>()
  async function getFx(currency: string): Promise<number | null> {
    if (currency === refCurrency) return 1
    if (fxCache.has(currency)) return fxCache.get(currency)!
    const r = await getRateSafe(currency, refCurrency)
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
      const d = 10 ** (lot.decimals as number)
      const qty = parseFloat(lot.quantity as string)
      const priceMajor = parseFloat(lot.price_per_unit as string) / d
      const amount = qty * priceMajor
      const rate = await getFx(lot.currency as string)
      if (rate === null) continue
      cashFlows.push({
        amount: lot.transaction_type === 'buy' ? -(amount * rate) : +(amount * rate),
        date: new Date(lot.transaction_date as string),
      })
    }
  }

  let totalValue = 0
  for (const e of entries) {
    const d = 10 ** e.currency_decimals
    const major = parseFloat(e.value_minor) / d
    const rate = await getFx(e.currency)
    totalValue += major * (rate ?? 1)
  }

  if (totalValue <= 0) return null

  cashFlows.push({ amount: totalValue, date: new Date(date) })
  return computeReturn(cashFlows)
}

// Pool all family members' lots for a single asset and compute combined XIRR.
async function computeAssetXirr(
  userIds: string[],
  assetId: string,
  assetCurrency: string,
  currencyDecimals: number,
  combinedValueMinor: number,
  date: string,
): Promise<number | null> {
  const lots = await sql`
    SELECT l.holding_id, l.transaction_type, l.quantity, l.price_per_unit, l.transaction_date
    FROM lots l
    JOIN holdings h ON h.id = l.holding_id
    JOIN assets a ON a.id = h.asset_id
    WHERE h.user_id = ANY(${userIds}::uuid[])
      AND h.asset_id = ${assetId}
      AND h.is_deleted = false
      AND a.cost_basis_mode = 'fixed'
      AND a.data_type != 'bank_balance'
      AND l.is_deleted = false
      AND l.transaction_date <= ${date}::date
    ORDER BY l.transaction_date ASC, l.created_at ASC
  `
  if (lots.length === 0) return null

  // Trim per holding before pooling - each member's position is independent
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byHolding = new Map<string, any[]>()
  for (const lot of lots) {
    const hid = lot.holding_id as string
    if (!byHolding.has(hid)) byHolding.set(hid, [])
    byHolding.get(hid)!.push(lot)
  }

  const divisor = 10 ** currencyDecimals
  const cashFlows: CashFlow[] = []
  for (const holdingLots of byHolding.values()) {
    const effectiveLots = trimLotsToCurrentPosition(holdingLots)
    for (const l of effectiveLots) {
      const qty = parseFloat(l.quantity as string)
      const priceMajor = parseFloat(l.price_per_unit as string) / divisor
      const amount = qty * priceMajor
      cashFlows.push({
        amount: l.transaction_type === 'buy' ? -amount : +amount,
        date: new Date(l.transaction_date as string),
      })
    }
  }

  if (cashFlows.length === 0) return null

  const terminalValue = combinedValueMinor / divisor
  if (terminalValue <= 0) return null

  cashFlows.push({ amount: terminalValue, date: new Date(date) })
  cashFlows.sort((a, b) => a.date.getTime() - b.date.getTime())
  return computeReturn(cashFlows)
}

export async function buildFamilySnapshotForDate(familyId: string, date: string): Promise<void> {
  const members = await getIncludedMembers(familyId)
  if (members.length === 0) return

  // Find which included members have an individual snapshot on this date
  const memberSnapIds: Array<{ userId: string; snapId: string }> = []
  for (const member of members) {
    const [snap] = await sql`
      SELECT id::text AS id FROM portfolio_snapshots
      WHERE user_id = ${member.id} AND snapshot_date = ${date}::date
    `
    if (snap) memberSnapIds.push({ userId: member.id, snapId: snap.id as string })
  }
  if (memberSnapIds.length === 0) return

  // Collect all entries from each member's snapshot
  const allEntries: FamilyEntry[] = []
  for (const ms of memberSnapIds) {
    const rows = await sql`
      SELECT
        pse.holding_id::text, pse.asset_id::text, pse.asset_name, pse.asset_category,
        pse.currency, pse.quantity::text, pse.price_per_unit_minor::text,
        pse.value_minor::text, pse.xirr::text,
        cur.decimals AS currency_decimals
      FROM portfolio_snapshot_entries pse
      JOIN currencies cur ON cur.code = pse.currency
      WHERE pse.snapshot_id = ${ms.snapId}
    `
    for (const r of rows) {
      allEntries.push({
        user_id: ms.userId,
        holding_id: r.holding_id as string,
        asset_id: r.asset_id as string,
        asset_name: r.asset_name as string,
        asset_category: r.asset_category as string,
        currency: r.currency as string,
        currency_decimals: r.currency_decimals as number,
        quantity: r.quantity as string,
        price_per_unit_minor: r.price_per_unit_minor as string,
        value_minor: r.value_minor as string,
        xirr: r.xirr as string | null,
      })
    }
  }

  if (allEntries.length === 0) return

  const refCurrency = members[0].base_currency
  const includedUserIds = memberSnapIds.map(ms => ms.userId)

  // Aggregate per-holding entries into one entry per asset_id.
  // Values and quantities are summed. XIRR is computed from all members' pooled lots.
  const assetMap = new Map<string, {
    representative: FamilyEntry
    totalValueMinor: number
    totalQuantity: number
  }>()
  for (const e of allEntries) {
    const existing = assetMap.get(e.asset_id)
    if (!existing) {
      assetMap.set(e.asset_id, {
        representative: e,
        totalValueMinor: parseFloat(e.value_minor),
        totalQuantity: parseFloat(e.quantity),
      })
    } else {
      existing.totalValueMinor += parseFloat(e.value_minor)
      existing.totalQuantity += parseFloat(e.quantity)
    }
  }

  // Compute pooled XIRR per asset from all family members' lots
  const aggregatedEntries: Array<FamilyEntry & { combinedValueMinor: number; combinedQuantity: number }> = []
  for (const [assetId, agg] of assetMap.entries()) {
    const e = agg.representative
    let assetXirr: number | null = null
    try {
      assetXirr = await computeAssetXirr(
        includedUserIds, assetId, e.currency, e.currency_decimals,
        agg.totalValueMinor, date,
      )
    } catch { /* non-fatal */ }

    aggregatedEntries.push({
      ...e,
      xirr: assetXirr !== null ? String(assetXirr) : null,
      combinedValueMinor: agg.totalValueMinor,
      combinedQuantity: agg.totalQuantity,
    })
  }

  let portfolioXirr: number | null = null
  try {
    portfolioXirr = await computeFamilyPortfolioXirr(includedUserIds, allEntries, refCurrency, date)
  } catch { /* non-fatal */ }

  await sql.begin(async tx => {
    const [snap] = await tx`
      INSERT INTO family_portfolio_snapshots (family_id, snapshot_date, source, portfolio_xirr)
      VALUES (${familyId}, ${date}::date, 'cron', ${portfolioXirr ?? null})
      ON CONFLICT (family_id, snapshot_date) DO UPDATE SET
        portfolio_xirr = EXCLUDED.portfolio_xirr,
        updated_at     = NOW()
      RETURNING id
    `

    await tx`DELETE FROM family_portfolio_snapshot_entries WHERE snapshot_id = ${snap.id}`

    for (const e of aggregatedEntries) {
      const combinedPricePerUnitMinor = e.combinedQuantity > 0
        ? Math.round(e.combinedValueMinor / e.combinedQuantity)
        : parseInt(e.price_per_unit_minor)
      await tx`
        INSERT INTO family_portfolio_snapshot_entries (
          snapshot_id, user_id, holding_id, asset_id, asset_name, asset_category,
          currency, quantity, price_per_unit_minor, value_minor, xirr
        ) VALUES (
          ${snap.id}, ${e.user_id}, ${e.holding_id}, ${e.asset_id}, ${e.asset_name},
          ${e.asset_category}, ${e.currency}, ${e.combinedQuantity.toString()},
          ${combinedPricePerUnitMinor.toString()}, ${e.combinedValueMinor.toString()},
          ${e.xirr ?? null}
        )
      `
    }
  })

  logger.info(`[family-snapshots] family ${familyId} on ${date}: ${aggregatedEntries.length} assets from ${memberSnapIds.length} member(s) (${allEntries.length} holdings merged)`)
}

export async function runFamilySnapshotBackfill(familyId: string): Promise<void> {
  const members = await getIncludedMembers(familyId)
  if (members.length === 0) {
    logger.info(`[family-snapshots] no included members for family ${familyId}`)
    return
  }

  const memberIds = members.map(m => m.id)

  const dates = await sql`
    SELECT DISTINCT snapshot_date::text AS date
    FROM portfolio_snapshots
    WHERE user_id = ANY(${memberIds}::uuid[])
    ORDER BY date ASC
  `

  if (dates.length === 0) {
    logger.info(`[family-snapshots] no individual snapshots for family ${familyId}`)
    return
  }

  logger.info(`[family-snapshots] backfill family ${familyId}: ${dates.length} date(s) (concurrency=${CONCURRENCY})`)

  let done = 0
  await runWithConcurrency(dates, CONCURRENCY, async row => {
    await buildFamilySnapshotForDate(familyId, row.date as string)
    done++
    if (done % 10 === 0) logger.info(`[family-snapshots] progress: ${done}/${dates.length}`)
  })

  logger.info(`[family-snapshots] backfill complete for family ${familyId}: ${done}/${dates.length}`)
}
