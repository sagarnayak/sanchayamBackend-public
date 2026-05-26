import { logger } from '../../lib/logger'
import { CorporateActionsResult } from './types'
import { fetchSplitsBonuses } from './yahoo'
import { fetchNseAnnouncements } from './nse'
import { validateCorporateActions, validateAssetAliases } from './validate'
import { extractFromNseAnnouncements } from './deepseek'
import { emit } from '../notifications'

export type AssetInfo = {
  asset_id: string
  symbol: string
  name: string
  exchange: string        // NSE | BSE | NASDAQ | NYSE | etc.
  data_type: string       // equity_india | equity_us | mutual_fund_india | crypto
  earliest_date: string   // earliest lot date for this asset (YYYY-MM-DD)
}

export async function resolveCorporateActions(asset: AssetInfo): Promise<CorporateActionsResult> {
  const result: CorporateActionsResult = {
    asset_id: asset.asset_id,
    actions: [],
    aliases: [],
    pre2003_gap: false,
  }

  const isIndiaEquity = asset.data_type === 'equity_india'
  const isUsEquity = asset.data_type === 'equity_us'

  if (!isIndiaEquity && !isUsEquity) {
    // Mutual funds and crypto have no corporate actions to resolve
    return result
  }

  // --- Splits and bonuses via Yahoo Finance ---
  // Validation failures do not abort the pipeline - admin is notified, we continue with what's valid
  try {
    const rawSplits = await fetchSplitsBonuses(asset.symbol, asset.exchange)
    const validatedSplits = await validateCorporateActions(rawSplits, asset.symbol, 'Yahoo splits')
    result.actions.push(...validatedSplits)
    logger.info(`[corporateActions] ${asset.symbol}: ${validatedSplits.length} split/bonus event(s) from Yahoo`)
  } catch (err) {
    logger.error({ err }, `[corporateActions] ${asset.symbol}: Yahoo splits fetch/validation failed`)
    // HTTP failures should propagate - validation failures should not block aliases/NSE step
    if (err instanceof Error && err.message.startsWith('Validation failed')) {
      // Already notified admin via emit in validate.ts - continue
    } else {
      throw err
    }
  }

  // --- Name changes, symbol changes, mergers via NSE announcements (India only) ---
  if (isIndiaEquity) {
    try {
      // NSE API expects plain symbol without exchange suffix (e.g. ITC not ITC:NSE)
      const nseSymbol = asset.symbol.split(':')[0]
      const announcements = await fetchNseAnnouncements(nseSymbol)
      logger.info(`[corporateActions] ${asset.symbol}: ${announcements.length} NSE announcement(s) fetched`)

      const { actions: rawNseActions, aliases: rawNseAliases } = await extractFromNseAnnouncements(nseSymbol, announcements)

      const validatedAliases = await validateAssetAliases(rawNseAliases, asset.symbol, 'NSE announcements')
      const validatedNseActions = await validateCorporateActions(rawNseActions, asset.symbol, 'NSE announcements')

      result.aliases.push(...validatedAliases)
      result.actions.push(...validatedNseActions)

      logger.info(`[corporateActions] ${asset.symbol}: ${validatedAliases.length} alias(es), ${validatedNseActions.length} action(s) from NSE via DeepSeek`)

      // Check if we have a gap before 2003
      if (asset.earliest_date < '2003-01-01') {
        result.pre2003_gap = true
        logger.warn(`[corporateActions] ${asset.symbol}: earliest lot date ${asset.earliest_date} is before 2003 - NSE announcements do not cover this period`)
        emit('CORPORATE_ACTION_PRE2003_GAP', {
          symbol: asset.symbol,
          assetId: asset.asset_id,
          earliestDate: asset.earliest_date,
        })
      }
    } catch (err) {
      logger.error({ err }, `[corporateActions] ${asset.symbol}: NSE announcements fetch/validation failed`)
      throw err
    }
  }

  return result
}

export { fetchWeeklyPrices } from './yahoo'
export { fetchMfNavHistory } from './mfapi'
export { validateWeeklyPrices, validateMfNavHistory } from './validate'
