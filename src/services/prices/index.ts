import { logger } from '../../lib/logger'
import crypto from 'crypto'
import sql from '../../db'
import { emit } from '../notifications'
import { env } from '../../config/env'

type Provider = {
  name: string
  apiKey: string
  baseUrl: string
  rateLimitPerMin: number
}

const registry = new Map<string, Provider>()

function decryptKey(encHex: string, ivHex: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex')
  const iv = Buffer.from(ivHex, 'hex')
  const data = Buffer.from(encHex, 'hex')
  const tag = data.slice(data.length - 16)
  const encrypted = data.slice(0, data.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8')
}

async function loadProviders(): Promise<void> {
  const encKey = env.ENCRYPTION_KEY
  const rows = await sql`
    SELECT name, api_key_enc, api_key_iv, base_url, rate_limit_per_min
    FROM data_collectors
    WHERE is_active = true
  `
  registry.clear()
  for (const row of rows) {
    const apiKey = row.api_key_enc
      ? decryptKey(row.api_key_enc, row.api_key_iv, encKey)
      : ''
    registry.set(row.name, {
      name: row.name,
      apiKey,
      baseUrl: row.base_url ?? 'https://api.twelvedata.com',
      rateLimitPerMin: row.rate_limit_per_min,
    })
  }
}

export async function syncProviders(): Promise<void> {
  await loadProviders()
  logger.info(`[prices] ${registry.size} provider(s) loaded`)
}

async function resolveProvider(dataType: string, symbol: string | null): Promise<Provider | null> {
  const [row] = await sql`
    SELECT pr.collector_name FROM provider_routing pr
    JOIN data_collectors dc ON dc.name = pr.collector_name
    WHERE pr.data_type = ${dataType}
      AND (pr.symbol = ${symbol} OR pr.symbol IS NULL)
      AND pr.is_active = true
      AND dc.is_active = true
    ORDER BY pr.symbol NULLS LAST
    LIMIT 1
  `
  if (!row) return null
  return registry.get(row.collector_name) ?? null
}

export async function enqueue(assetId: string, priority = 2): Promise<void> {
  await sql`
    INSERT INTO price_fetch_queue (asset_id, status, priority, queued_at)
    VALUES (${assetId}, 'pending', ${priority}, NOW())
    ON CONFLICT DO NOTHING
  `
}

function toYahooSymbol(symbol: string): string {
  return symbol.replace(':NSE', '.NS').replace(':BSE', '.BO')
}

async function fetchPrice(provider: Provider, symbol: string): Promise<string> {
  if (provider.name === 'twelve-data') {
    const url = `${provider.baseUrl}/price?symbol=${encodeURIComponent(symbol)}&apikey=${provider.apiKey}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`Twelve Data API error: ${res.status} ${res.statusText}`)
    const data = await res.json() as { price?: string; status?: string; message?: string }
    if (data.status === 'error') throw new Error(data.message ?? 'Unknown API error')
    if (!data.price) throw new Error(`No price returned for ${symbol}`)
    return data.price
  }

  if (provider.name === 'yahoo-finance') {
    const ySymbol = toYahooSymbol(symbol)
    const url = `${provider.baseUrl}/v8/finance/chart/${encodeURIComponent(ySymbol)}`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    if (!res.ok) throw new Error(`Yahoo Finance error: ${res.status} ${res.statusText}`)
    const data = await res.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }>; error?: { description?: string } } }
    if (data.chart?.error) throw new Error(data.chart.error.description ?? 'Yahoo Finance error')
    const price = data.chart?.result?.[0]?.meta?.regularMarketPrice
    if (price == null) throw new Error(`No price returned for ${symbol}`)
    return String(price)
  }

  if (provider.name === 'mfapi-in') {
    const url = `${provider.baseUrl}/mf/${encodeURIComponent(symbol)}/latest`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`mfapi.in error: ${res.status} ${res.statusText}`)
    const data = await res.json() as { status?: string; data?: Array<{ nav: string }> }
    if (data.status !== 'SUCCESS') throw new Error(`mfapi.in error for ${symbol}`)
    const nav = data.data?.[0]?.nav
    if (!nav) throw new Error(`No NAV returned for ${symbol}`)
    return nav
  }

  throw new Error(`No fetch implementation for provider: ${provider.name}`)
}

async function upsertPrice(assetId: string, price: string): Promise<void> {
  const [asset] = await sql`
    SELECT cur.decimals
    FROM assets a
    JOIN currencies cur ON cur.code = a.currency
    WHERE a.id = ${assetId}
  `
  if (!asset) throw new Error(`Asset ${assetId} not found`)

  const priceMinor = Math.round(parseFloat(price) * (10 ** (asset.decimals as number)))

  await sql`
    INSERT INTO asset_price_history (asset_id, price_date, price, recorded_at, source)
    VALUES (${assetId}, CURRENT_DATE, ${priceMinor.toString()}, NOW(), 'api')
    ON CONFLICT (asset_id, price_date)
    DO UPDATE SET price = EXCLUDED.price, recorded_at = EXCLUDED.recorded_at
  `
}

// Check collector_call_log for last call time and wait if needed to respect rate limit.
// Applies to both worker fetches and synchronous first-time fetches.
async function enforceRateLimit(provider: Provider): Promise<void> {
  const [lastCall] = await sql`
    SELECT called_at FROM collector_call_log
    WHERE collector_name = ${provider.name}
    ORDER BY called_at DESC
    LIMIT 1
  `
  if (!lastCall) return
  const minDelay = Math.ceil(60000 / provider.rateLimitPerMin)
  const elapsed = Date.now() - new Date(lastCall.called_at).getTime()
  if (elapsed < minDelay) {
    await sleep(minDelay - elapsed)
  }
}

function logCall(collectorName: string, dataType: string, success: boolean, error: string | null): void {
  sql`
    INSERT INTO collector_call_log (collector_name, data_type, success, items_requested, items_returned, error_message)
    VALUES (${collectorName}, ${dataType}, ${success}, 1, ${success ? 1 : 0}, ${error})
  `.catch(() => {})
}

function touchPriceConsumed(assetIds: string[]): void {
  if (assetIds.length === 0) return
  sql`
    UPDATE assets SET price_last_consumed_at = NOW()
    WHERE id = ANY(${assetIds}::uuid[])
  `.catch(() => {})
}

export async function getPriceForDate(dataType: string, assetId: string, date: string): Promise<{ price: string; recordedAt: Date } | null> {
  const rows = await sql`
    SELECT h.price, h.price_date, h.recorded_at, cur.decimals
    FROM asset_price_history h
    JOIN assets a ON a.id = h.asset_id
    JOIN currencies cur ON cur.code = a.currency
    WHERE h.asset_id = ${assetId}
      AND h.price_date <= ${date}
    ORDER BY h.price_date DESC
    LIMIT 1
  `
  if (rows.length === 0) return null
  const row = rows[0]
  const priceMajor = parseFloat(row.price) / (10 ** (row.decimals as number))
  return { price: priceMajor.toString(), recordedAt: new Date(row.recorded_at) }
}

export async function getLatestPrice(dataType: string, assetId: string): Promise<{ price: string; recordedAt: Date; isStale: boolean } | null> {
  const rows = await sql`
    SELECT h.price, h.price_date, h.recorded_at, cur.decimals
    FROM asset_price_history h
    JOIN assets a ON a.id = h.asset_id
    JOIN currencies cur ON cur.code = a.currency
    WHERE h.asset_id = ${assetId}
    ORDER BY h.price_date DESC
    LIMIT 1
  `

  if (rows.length === 0) {
    // No data yet - enqueue at user-request priority and return null.
    // Never make a live API call inline in response to a user request.
    await enqueue(assetId, 1)
    return null
  }

  touchPriceConsumed([assetId])

  const row = rows[0]
  const age = Date.now() - new Date(row.recorded_at).getTime()
  const isStale = age > 24 * 60 * 60 * 1000
  const priceMajor = parseFloat(row.price) / (10 ** (row.decimals as number))

  return { price: priceMajor.toString(), recordedAt: new Date(row.recorded_at), isStale }
}

export async function getLatestPricesBulk(
  holdings: Array<{ asset_id: string; data_type: string }>
): Promise<Map<string, { price: string; recordedAt: Date; isStale: boolean }>> {
  const result = new Map<string, { price: string; recordedAt: Date; isStale: boolean }>()
  if (holdings.length === 0) return result

  const assetIds = [...new Set(holdings.map(h => h.asset_id))]

  const rows = await sql`
    SELECT DISTINCT ON (h.asset_id)
      h.asset_id, h.price, h.price_date, h.recorded_at, cur.decimals
    FROM asset_price_history h
    JOIN assets a ON a.id = h.asset_id
    JOIN currencies cur ON cur.code = a.currency
    WHERE h.asset_id = ANY(${assetIds}::uuid[])
    ORDER BY h.asset_id, h.price_date DESC
  `

  const foundIds: string[] = []
  const now = Date.now()
  for (const row of rows) {
    const age = now - new Date(row.recorded_at).getTime()
    const isStale = age > 24 * 60 * 60 * 1000
    const priceMajor = parseFloat(row.price) / (10 ** (row.decimals as number))
    result.set(row.asset_id as string, {
      price: priceMajor.toString(),
      recordedAt: new Date(row.recorded_at),
      isStale,
    })
    foundIds.push(row.asset_id as string)
  }

  touchPriceConsumed(foundIds)

  // Assets with no data at all get high-priority queue entries
  const missingIds = assetIds.filter(id => !result.has(id))
  for (const id of missingIds) {
    await enqueue(id, 1)
  }

  return result
}

// Called by the every-minute cron. Enqueues assets that need a price refresh:
// - no price at all (new asset)
// - price not fetched in 24h AND consumed within last 48h (active but stale)
// Assets not consumed in 48h are skipped - nobody is looking at them.
export async function enqueueStalePrices(): Promise<void> {
  const stale = await sql`
    SELECT DISTINCT a.id FROM assets a
    JOIN holdings h ON h.asset_id = a.id
    WHERE a.update_mode = 'api'
      AND a.is_deleted = false
      AND a.is_active = true
      AND h.is_deleted = false
      AND h.status = 'active'
      AND (
        NOT EXISTS (
          SELECT 1 FROM asset_price_history p WHERE p.asset_id = a.id
        )
        OR (
          NOT EXISTS (
            SELECT 1 FROM asset_price_history p
            WHERE p.asset_id = a.id
              AND p.recorded_at >= NOW() - INTERVAL '24 hours'
          )
          AND a.price_last_consumed_at > NOW() - INTERVAL '48 hours'
        )
      )
  `
  let count = 0
  for (const row of stale) {
    await enqueue(row.id as string, 2)
    count++
  }
  if (count > 0) {
    logger.info(`[prices] enqueued ${count} asset(s) for price refresh`)
  }
}

async function priceWorker(): Promise<void> {
  while (true) {
    const [item] = await sql`
      SELECT pq.id, pq.asset_id, pq.retry_count,
             a.symbol, a.data_type
      FROM price_fetch_queue pq
      JOIN assets a ON a.id = pq.asset_id
      WHERE pq.status = 'pending'
      ORDER BY pq.priority ASC, pq.queued_at ASC
      LIMIT 1
      FOR UPDATE OF pq SKIP LOCKED
    `

    if (!item) {
      await sleep(5000)
      continue
    }

    await sql`
      UPDATE price_fetch_queue
      SET status = 'in_progress', started_at = NOW()
      WHERE id = ${item.id}
    `

    let provider: Provider | null = null

    try {
      provider = await resolveProvider(item.data_type, item.symbol)
      if (!provider) {
        await sql`
          UPDATE price_fetch_queue
          SET status = 'failed', completed_at = NOW(),
              error = 'no provider configured for this data type'
          WHERE id = ${item.id}
        `
        await sleep(2000)
        continue
      }

      await enforceRateLimit(provider)

      const price = await fetchPrice(provider, item.symbol)
      await upsertPrice(item.asset_id, price)

      await sql`
        UPDATE price_fetch_queue
        SET status = 'done', completed_at = NOW()
        WHERE id = ${item.id}
      `
      logCall(provider.name, item.data_type, true, null)
      logger.info(`[prices] fetched ${item.symbol} (${item.data_type}): ${price}`)

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const retries = (item.retry_count as number) + 1

      if (provider) logCall(provider.name, item.data_type, false, message)

      if (retries >= 3) {
        await sql`
          UPDATE price_fetch_queue
          SET status = 'failed', retry_count = ${retries},
              error = ${message}, completed_at = NOW()
          WHERE id = ${item.id}
        `
        await emit('PRICE_FETCH_FAILED', {
          assetId: item.asset_id,
          symbol: item.symbol,
          retries,
          error: message,
        })
        logger.error(`[prices] permanent failure for ${item.symbol}: ${message}`)
      } else {
        await sql`
          UPDATE price_fetch_queue
          SET status = 'pending', retry_count = ${retries},
              started_at = NULL, error = ${message}
          WHERE id = ${item.id}
        `
        logger.warn(`[prices] retry ${retries}/3 for ${item.symbol}: ${message}`)
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function startPriceWorker(): void {
  priceWorker().catch(err => {
    logger.error({ err }, '[prices] worker crashed:')
    setTimeout(startPriceWorker, 10000)
  })
  logger.info('[prices] worker started')
}
