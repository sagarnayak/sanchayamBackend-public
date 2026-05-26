import { logger } from '../../lib/logger'
import sql from '../../db'

// Backfill window: earliest lot date -> last completed Friday (exclusive of current week)
// Today's week is owned by the live price feed.
function lastCompletedFriday(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  // Go back to most recent Friday that is NOT in the current week
  // Current week runs Mon-Sun. Last completed Friday = last Friday before this Monday.
  const dow = d.getDay() // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  // Days since last Friday: Sun=2, Mon=3, Tue=4, Wed=5, Thu=6, Fri=0(this week), Sat=1
  // We want the Friday BEFORE the current Mon-Sun week
  const daysToLastMonday = dow === 0 ? 6 : dow - 1
  const thisMonday = new Date(d)
  thisMonday.setDate(d.getDate() - daysToLastMonday)
  const lastFriday = new Date(thisMonday)
  lastFriday.setDate(thisMonday.getDate() - 3)
  return lastFriday.toISOString().slice(0, 10)
}

export async function enqueueEligibleAssets(): Promise<void> {
  const windowEnd = lastCompletedFriday()

  // All API-mode assets that have at least one holding (active or exited)
  const assets = await sql`
    SELECT DISTINCT a.id, a.symbol, a.data_type
    FROM assets a
    JOIN holdings h ON h.asset_id = a.id
    WHERE a.update_mode = 'api'
      AND a.is_deleted = false
      AND h.is_deleted = false
      AND h.status IN ('active', 'exited')
  `

  let enqueued = 0

  for (const asset of assets) {
    const assetId = asset.id as string
    const isMutualFund = asset.data_type === 'mutual_fund_india'

    // Check if this asset has any active holdings.
    // Exited assets will never have new corporate actions - skip symbols and splits for them.
    const [activeCheck] = await sql`
      SELECT COUNT(*)::int AS cnt
      FROM holdings
      WHERE asset_id = ${assetId} AND status = 'active' AND is_deleted = false
    `
    const hasActiveHoldings = (activeCheck?.cnt as number) > 0

    // Mutual funds have no corporate actions - NAV self-adjusts. Skip symbols + splits.
    if (isMutualFund) {
      // Jump straight to prices stage check
      const [s3] = await sql`
        SELECT status FROM backfill_queue
        WHERE asset_id = ${assetId} AND stage = 'prices'
        ORDER BY queued_at DESC LIMIT 1
      `
      const earliestRow = await sql`
        SELECT COALESCE(
          (SELECT MIN(l.transaction_date)::text
           FROM lots l JOIN holdings h ON h.id = l.holding_id
           WHERE h.asset_id = ${assetId} AND l.is_deleted = false AND h.is_deleted = false),
          NULL
        ) AS earliest_date
      `
      const earliestDate = earliestRow[0]?.earliest_date as string | null
      if (!earliestDate) continue

      const [lastMfPrices] = await sql`
        SELECT last_checked_at FROM backfill_queue
        WHERE asset_id = ${assetId} AND stage = 'prices' AND status = 'done'
        ORDER BY last_checked_at DESC NULLS LAST LIMIT 1
      `
      const mfSince = lastMfPrices?.last_checked_at
        ? (lastMfPrices.last_checked_at as Date).toISOString().slice(0, 10)
        : earliestDate

      const [missingCheck] = await sql`
        SELECT COUNT(*)::int AS cnt
        FROM (
          SELECT generate_series(
            date_trunc('week', ${earliestDate}::date + interval '4 days')::date,
            ${windowEnd}::date,
            interval '7 days'
          )::date AS friday
        ) weeks
        WHERE friday > ${mfSince}::date
          AND NOT EXISTS (
            SELECT 1 FROM asset_price_history
            WHERE asset_id = ${assetId} AND price_date = weeks.friday
          )
      `
      if ((missingCheck?.cnt ?? 0) > 0) {
        await sql`
          INSERT INTO backfill_queue (asset_id, stage, status, priority)
          VALUES (${assetId}, 'prices', 'pending', 2)
          ON CONFLICT DO NOTHING
        `
        enqueued++
      }
      continue
    }

    // --- Stage 1: symbols ---
    // Only run for assets with active holdings (exited assets will never get new corporate actions).
    // Skip if alias data already exists - the full history was already fetched on a prior run.
    if (!hasActiveHoldings) {
      // Fall through to prices stage check - exited assets still need price backfill
    } else {
      const [s1] = await sql`
        SELECT status, last_checked_at FROM backfill_queue
        WHERE asset_id = ${assetId} AND stage = 'symbols'
        ORDER BY queued_at DESC LIMIT 1
      `
      const s1Done = s1?.status === 'done'

      // Check if alias data already exists (more than the single seed row from migration).
      // If it does, the API was already called and history is stored - no need to call again.
      const [aliasCheck] = await sql`
        SELECT COUNT(*)::int AS cnt FROM asset_aliases WHERE asset_id = ${assetId}
      `
      const hasAliasData = (aliasCheck?.cnt as number) > 1

      const s1NeedsRun = !s1 && !hasAliasData

      if (s1NeedsRun) {
        await sql`
          INSERT INTO backfill_queue (asset_id, stage, status, priority)
          VALUES (${assetId}, 'symbols', 'pending', 2)
          ON CONFLICT DO NOTHING
        `
        enqueued++
        continue  // don't check downstream stages until symbols is done
      }

      if (!s1Done && !hasAliasData) continue  // symbols pending/in_progress/failed - wait

      // --- Stage 2: splits ---
      // Only run if no split data exists yet for this asset.
      // Once fetched, the history is complete - no need to re-call the API.
      const [s2] = await sql`
        SELECT status, last_checked_at FROM backfill_queue
        WHERE asset_id = ${assetId} AND stage = 'splits'
        ORDER BY queued_at DESC LIMIT 1
      `
      const s2Done = s2?.status === 'done'

      const [splitCheck] = await sql`
        SELECT COUNT(*)::int AS cnt FROM corporate_actions WHERE asset_id = ${assetId}
      `
      const hasSplitData = (splitCheck?.cnt as number) > 0

      const s2NeedsRun = !s2 && !hasSplitData

      if (s2NeedsRun) {
        await sql`
          INSERT INTO backfill_queue (asset_id, stage, status, priority)
          VALUES (${assetId}, 'splits', 'pending', 2)
          ON CONFLICT DO NOTHING
        `
        enqueued++
        continue
      }

      if (!s2Done && !hasSplitData) continue  // splits pending/in_progress/failed - wait
    }

    // --- Stage 3: prices ---
    // Eligible if: stage 2 done AND missing Fridays exist within backfill window
    const earliestRow = await sql`
      SELECT COALESCE(
        (SELECT MIN(l.transaction_date)::text
         FROM lots l
         JOIN holdings h ON h.id = l.holding_id
         WHERE h.asset_id = ${assetId}
           AND l.is_deleted = false
           AND h.is_deleted = false),
        NULL
      ) AS earliest_date
    `
    const earliestDate = earliestRow[0]?.earliest_date as string | null
    if (!earliestDate) continue

    // Only re-queue for prices if there are Fridays NEWER than the last completed run.
    // Old missing Fridays (before last_checked_at) were already attempted by reconcileAsset
    // and have no data available - re-queuing them causes an infinite loop.
    // New missing Fridays (after last_checked_at) = a new week just ended = queue them.
    const [lastPrices] = await sql`
      SELECT last_checked_at FROM backfill_queue
      WHERE asset_id = ${assetId} AND stage = 'prices' AND status = 'done'
      ORDER BY last_checked_at DESC NULLS LAST LIMIT 1
    `
    const since = lastPrices?.last_checked_at
      ? (lastPrices.last_checked_at as Date).toISOString().slice(0, 10)
      : earliestDate

    const [missingCheck] = await sql`
      SELECT COUNT(*)::int AS cnt
      FROM (
        SELECT generate_series(
          date_trunc('week', ${earliestDate}::date + interval '4 days')::date,
          ${windowEnd}::date,
          interval '7 days'
        )::date AS friday
      ) weeks
      WHERE friday > ${since}::date
        AND NOT EXISTS (
          SELECT 1 FROM asset_price_history
          WHERE asset_id = ${assetId}
            AND price_date = weeks.friday
        )
    `

    if ((missingCheck?.cnt ?? 0) > 0) {
      await sql`
        INSERT INTO backfill_queue (asset_id, stage, status, priority)
        VALUES (${assetId}, 'prices', 'pending', 2)
        ON CONFLICT DO NOTHING
      `
      enqueued++
    }
  }

  if (enqueued > 0) {
    logger.info(`[backfill] watcher: ${enqueued} item(s) enqueued`)
  }
}
