import Big from 'big.js'
import sql from '../../db'
import { FXRateUnavailableError } from './types'
import { getCollector } from '../collectors'
import { emit } from '../notifications'

const PIVOT = 'USD'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const PROCESS_CACHE_TTL_MS = 5 * 60 * 1000

// In-process layer over the DB FX cache - avoids a DB round-trip on every resolveRate call
const rateProcessCache = new Map<string, { rate: string; cachedAt: number }>()

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function lookupCollector(currency: string): Promise<string> {
  const [map] = await sql`
    SELECT collector_name FROM currency_collector_map WHERE currency_code = ${currency}
  `
  if (!map) throw new Error(`No collector configured for currency ${currency}`)
  return map.collector_name as string
}

function touchConsumed(currency: string): void {
  sql`UPDATE fx_rates SET last_consumed_at = NOW() WHERE currency_code = ${currency}`.catch(() => {})
}

async function fetchAndCacheRate(currency: string, collectorName: string): Promise<string> {
  const collector = getCollector(collectorName)
  if (!collector.fetchFxRates) throw new Error(`Collector ${collectorName} does not support FX rates`)
  const rates = await collector.fetchFxRates([currency])
  const rate = rates.get(currency)
  if (!rate) throw new Error(`Collector returned no rate for ${currency}`)
  await sql`
    INSERT INTO fx_rates (currency_code, rate_vs_pivot, collector_name, fetched_at)
    VALUES (${currency}, ${rate}, ${collectorName}, NOW())
    ON CONFLICT (currency_code) DO UPDATE
      SET rate_vs_pivot = ${rate}, collector_name = ${collectorName}, fetched_at = NOW()
  `
  rateProcessCache.set(currency, { rate, cachedAt: Date.now() })
  return rate
}

export function invalidateRateProcessCache(currency?: string): void {
  if (currency) rateProcessCache.delete(currency)
  else rateProcessCache.clear()
}

async function resolveRate(currency: string): Promise<string> {
  if (currency === PIVOT) return '1'

  // In-process cache hit - no DB needed
  const inProcess = rateProcessCache.get(currency)
  if (inProcess && Date.now() - inProcess.cachedAt < PROCESS_CACHE_TTL_MS) {
    touchConsumed(currency)
    return inProcess.rate
  }

  const [cached] = await sql`
    SELECT rate_vs_pivot, fetched_at FROM fx_rates WHERE currency_code = ${currency}
  `

  if (cached) {
    touchConsumed(currency)
    const isFresh = (Date.now() - new Date(cached.fetched_at).getTime()) < CACHE_TTL_MS
    if (!isFresh) {
      // serve stale immediately, refresh in background
      lookupCollector(currency)
        .then(name => fetchAndCacheRate(currency, name))
        .catch(() => {})
    }
    const rate = cached.rate_vs_pivot as string
    rateProcessCache.set(currency, { rate, cachedAt: Date.now() })
    return rate
  }

  // No cached value at all - must fetch live
  let collectorName: string
  try {
    collectorName = await lookupCollector(currency)
  } catch (err) {
    emit('FX_RATE_UNAVAILABLE', { currency, error: String(err) })
    throw new FXRateUnavailableError(currency)
  }

  try {
    return await fetchAndCacheRate(currency, collectorName)
  } catch (err) {
    emit('FX_RATE_UNAVAILABLE', { currency, error: String(err) })
    throw new FXRateUnavailableError(currency)
  }
}

export async function getRate(from: string, to: string): Promise<string> {
  if (from === to) return '1'
  const [rateFrom, rateTo] = await Promise.all([resolveRate(from), resolveRate(to)])
  return new Big(rateFrom).div(new Big(rateTo)).toFixed(18)
}

export async function getRateSafe(from: string, to: string): Promise<string | null> {
  try {
    return await getRate(from, to)
  } catch {
    return null
  }
}

export async function refreshStaleRates(): Promise<void> {
  const stale = await sql`
    SELECT ccm.currency_code, ccm.collector_name, dc.rate_limit_per_min
    FROM currency_collector_map ccm
    LEFT JOIN fx_rates fr ON fr.currency_code = ccm.currency_code
    JOIN data_collectors dc ON dc.name = ccm.collector_name
    WHERE fr.currency_code IS NULL
       OR (
         fr.fetched_at < NOW() - INTERVAL '24 hours'
         AND fr.last_consumed_at IS NOT NULL
         AND fr.last_consumed_at > NOW() - INTERVAL '48 hours'
       )
  `

  for (const row of stale) {
    const currency     = row.currency_code as string
    const collectorName = row.collector_name as string
    const delayMs      = Math.ceil(60000 / (row.rate_limit_per_min as number))

    let success      = false
    let errorMessage: string | null = null

    try {
      const collector = getCollector(collectorName)
      if (!collector.fetchFxRates) throw new Error(`Collector ${collectorName} does not support FX rates`)

      const rates = await collector.fetchFxRates([currency])
      const rate  = rates.get(currency)
      if (!rate) throw new Error(`No rate returned for ${currency}`)

      await sql`
        INSERT INTO fx_rates (currency_code, rate_vs_pivot, collector_name, fetched_at)
        VALUES (${currency}, ${rate}, ${collectorName}, NOW())
        ON CONFLICT (currency_code) DO UPDATE
          SET rate_vs_pivot = ${rate}, collector_name = ${collectorName}, fetched_at = NOW()
      `
      success = true
    } catch (err) {
      errorMessage = String(err)
      emit('FX_RATE_UNAVAILABLE', { currency, collector: collectorName, error: errorMessage })
    }

    sql`
      INSERT INTO collector_call_log (collector_name, data_type, success, items_requested, items_returned, error_message)
      VALUES (${collectorName}, 'fx_rate', ${success}, 1, ${success ? 1 : 0}, ${errorMessage})
    `.catch(() => {})

    await sleep(delayMs)
  }
}
