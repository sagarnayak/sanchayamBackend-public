import { logger } from '../../lib/logger'
import sql from '../../db'
import { emit } from '../notifications'
import { resolveCorporateActions } from '../corporateActions'
import { fetchSplitsBonuses } from '../corporateActions/yahoo'
import { reconcileAsset } from '../reconciliation'
import { runHistoricalSnapshotBackfill } from '../snapshots/backfill'

// Rate limits (ms between calls) per API used in each stage
const STAGE_DELAY_MS: Record<string, number> = {
  symbols: 5000,   // NSE + DeepSeek - NSE is fragile, give it room
  splits:  2000,   // Yahoo Finance
  prices:  2000,   // Yahoo Finance / mfapi.in
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Enforce rate limit based on last call in collector_call_log for any relevant collector.
// Backfill uses yahoo-finance and nse (no key). We check the most recent call across all
// collectors used by backfill and wait if the gap is less than the stage's required delay.
async function enforceBackfillRateLimit(stage: string): Promise<void> {
  const delayMs = STAGE_DELAY_MS[stage] ?? 3000
  const collectors = stage === 'symbols'
    ? ['yahoo-finance', 'nse-announcements']
    : ['yahoo-finance']

  const [lastCall] = await sql`
    SELECT MAX(called_at) AS last_at
    FROM collector_call_log
    WHERE collector_name = ANY(${collectors}::text[])
  `
  if (!lastCall?.last_at) return

  const elapsed = Date.now() - new Date(lastCall.last_at).getTime()
  if (elapsed < delayMs) {
    await sleep(delayMs - elapsed)
  }
}

function logCall(collectorName: string, stage: string, success: boolean, error: string | null): void {
  sql`
    INSERT INTO collector_call_log (collector_name, data_type, success, items_requested, items_returned, error_message)
    VALUES (${collectorName}, ${'backfill_' + stage}, ${success}, 1, ${success ? 1 : 0}, ${error})
  `.catch(() => {})
}

async function upsertCorporateActions(assetId: string, actions: import('../corporateActions/types').CorporateAction[]): Promise<void> {
  for (const a of actions) {
    await sql`
      INSERT INTO corporate_actions
        (asset_id, action_type, action_date, ratio_from, ratio_to, merged_into_asset_id, notes)
      VALUES (
        ${assetId}, ${a.action_type}, ${a.action_date}::date,
        ${a.ratio_from ?? null}, ${a.ratio_to ?? null}, NULL, ${a.notes ?? null}
      )
      ON CONFLICT DO NOTHING
    `
  }
}

async function upsertAssetAliases(assetId: string, aliases: import('../corporateActions/types').AssetAlias[]): Promise<void> {
  for (const a of aliases) {
    await sql`
      INSERT INTO asset_aliases (asset_id, symbol, name, from_date, to_date)
      VALUES (
        ${assetId}, ${a.symbol}, ${a.name}, ${a.from_date}::date,
        ${a.to_date ? sql`${a.to_date}::date` : sql`NULL`}
      )
      ON CONFLICT DO NOTHING
    `
  }
}

async function runStage(assetId: string, stage: string, symbol: string, dataType: string): Promise<void> {
  await enforceBackfillRateLimit(stage)

  if (stage === 'symbols') {
    const exchange = dataType === 'equity_india' ? 'NSE' : dataType === 'equity_us' ? 'US' : 'NSE'
    const [assetRow] = await sql`SELECT name FROM assets WHERE id = ${assetId}`
    const result = await resolveCorporateActions({
      asset_id: assetId,
      symbol,
      name: assetRow?.name as string ?? symbol,
      exchange,
      data_type: dataType,
      earliest_date: await getEarliestDate(assetId),
    })
    await upsertAssetAliases(assetId, result.aliases)
    await upsertCorporateActions(assetId, result.actions)
    logCall('nse-announcements', stage, true, null)
    logger.info(`[backfill] ${symbol} symbols: ${result.aliases.length} alias(es), ${result.actions.length} action(s)`)
    return
  }

  if (stage === 'splits') {
    const exchange = dataType === 'equity_india' ? 'NSE' : dataType === 'equity_us' ? 'US' : 'NSE'
    const actions = await fetchSplitsBonuses(symbol, exchange)
    await upsertCorporateActions(assetId, actions)
    logCall('yahoo-finance', stage, true, null)
    logger.info(`[backfill] ${symbol} splits: ${actions.length} action(s)`)
    return
  }

  if (stage === 'prices') {
    await reconcileAsset(assetId)
    logCall('yahoo-finance', stage, true, null)
    logger.info(`[backfill] ${symbol} prices: reconcile complete`)
    return
  }

  throw new Error(`Unknown stage: ${stage}`)
}

async function getEarliestDate(assetId: string): Promise<string> {
  const [row] = await sql`
    SELECT MIN(l.transaction_date)::text AS earliest
    FROM lots l
    JOIN holdings h ON h.id = l.holding_id
    WHERE h.asset_id = ${assetId}
      AND l.is_deleted = false
      AND h.is_deleted = false
  `
  return (row?.earliest as string) ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

async function backfillWorker(): Promise<void> {
  while (true) {
    const [item] = await sql`
      SELECT bq.id, bq.asset_id, bq.stage, bq.retry_count,
             a.symbol, a.data_type
      FROM backfill_queue bq
      JOIN assets a ON a.id = bq.asset_id
      WHERE bq.status = 'pending'
      ORDER BY bq.priority ASC, bq.queued_at ASC
      LIMIT 1
      FOR UPDATE OF bq SKIP LOCKED
    `

    if (!item) {
      await sleep(10000)
      continue
    }

    await sql`
      UPDATE backfill_queue SET status = 'in_progress', started_at = NOW()
      WHERE id = ${item.id}
    `

    try {
      await runStage(item.asset_id as string, item.stage as string, item.symbol as string, item.data_type as string)

      await sql`
        UPDATE backfill_queue
        SET status = 'done', completed_at = NOW(), last_checked_at = NOW(), error = NULL
        WHERE id = ${item.id}
      `

      // When an asset's prices stage fully completes, trigger snapshot backfill.
      // Only fires if there are no more pending/in_progress prices rows for this asset.
      // The snapshot backfill itself gates on all assets being ready for a given date,
      // so calling it here is safe - it will only produce snapshots for fully-covered dates.
      if (item.stage === 'prices') {
        const [remaining] = await sql`
          SELECT COUNT(*)::int AS cnt
          FROM backfill_queue
          WHERE asset_id = ${item.asset_id}
            AND stage    = 'prices'
            AND status   IN ('pending', 'in_progress')
        `
        if ((remaining?.cnt as number) === 0) {
          logger.info(`[backfill] ${item.symbol} prices complete - triggering snapshot backfill`)
          runHistoricalSnapshotBackfill().catch(err => {
            logger.error({ err }, '[backfill] snapshot backfill trigger error:')
          })
        }
      }

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const retries = (item.retry_count as number) + 1

      if (retries >= 3) {
        await sql`
          UPDATE backfill_queue
          SET status = 'failed', retry_count = ${retries}, completed_at = NOW(), error = ${message}
          WHERE id = ${item.id}
        `
        emit('BACKFILL_STAGE_FAILED', {
          assetId: item.asset_id,
          symbol: item.symbol,
          stage: item.stage,
          retries,
          error: message,
        })
        logger.error(`[backfill] permanent failure: ${item.symbol} stage=${item.stage}: ${message}`)
      } else {
        await sql`
          UPDATE backfill_queue
          SET status = 'pending', retry_count = ${retries}, started_at = NULL, error = ${message}
          WHERE id = ${item.id}
        `
        logger.warn(`[backfill] retry ${retries}/3: ${item.symbol} stage=${item.stage}: ${message}`)
      }
    }
  }
}

async function resetStaleInProgress(): Promise<void> {
  const { count } = await sql`
    UPDATE backfill_queue
    SET status = 'pending', started_at = NULL, error = 'reset on startup'
    WHERE status = 'in_progress'
  `.then(r => ({ count: r.count }))
  if (count > 0) {
    logger.info(`[backfill] reset ${count} stale in_progress item(s) to pending`)
  }
}

export function startBackfillWorker(): void {
  resetStaleInProgress()
    .then(() => backfillWorker())
    .catch(err => {
      logger.error({ err }, '[backfill] worker crashed:')
      setTimeout(startBackfillWorker, 15000)
    })
  logger.info('[backfill] worker started')
}
