import { CorporateAction } from './types'

const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0' }

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: YAHOO_HEADERS })
  if (res.status === 404) return null  // delisted or unknown symbol - not an error
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}: ${url}`)
  return res.json()
}

function yahooSymbol(symbol: string, exchange: string): string {
  // Strip any exchange suffix already in the symbol (e.g. APOLLOTYRE:NSE -> APOLLOTYRE)
  const base = symbol.split(':')[0]
  if (exchange === 'NSE') return `${base}.NS`
  if (exchange === 'BSE') return `${base}.BO`
  return base
}

export async function fetchSplitsBonuses(symbol: string, exchange: string): Promise<CorporateAction[]> {
  const ySym = yahooSymbol(symbol, exchange)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ySym}?events=split&range=max&interval=1mo`

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await fetchJson(url)) as any
  const result = data?.chart?.result?.[0]
  if (!result) return []

  const splits: Record<string, { numerator: number; denominator: number; date: number }> =
    result.events?.splits ?? {}

  return Object.values(splits).map(s => {
    const action_date = new Date(s.date * 1000).toISOString().slice(0, 10)
    // Yahoo encodes: numerator = new shares, denominator = old shares
    // e.g. 2:1 split -> numerator=2, denominator=1 -> ratio_from=1, ratio_to=2
    return {
      action_type: 'split' as const,
      action_date,
      ratio_from: s.denominator,
      ratio_to: s.numerator,
      merged_into_symbol: null,
      notes: `Yahoo Finance: ${s.numerator}:${s.denominator}`,
    }
  }).sort((a, b) => a.action_date.localeCompare(b.action_date))
}

export type WeeklyPrice = {
  price_date: string  // YYYY-MM-DD (always set to Friday or nearest trading day)
  close: number       // raw float from Yahoo - caller converts to minor units
}

export async function fetchWeeklyPrices(symbol: string, exchange: string, fromDate?: string): Promise<WeeklyPrice[]> {
  const ySym = yahooSymbol(symbol, exchange)

  // Use period1/period2 instead of range=max to avoid Yahoo silently falling back
  // to monthly bars when the full history is too long (>~500 data points).
  const period1 = fromDate
    ? Math.floor(new Date(fromDate).getTime() / 1000)
    : Math.floor(new Date('2000-01-01').getTime() / 1000)
  const period2 = Math.floor(Date.now() / 1000)

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ySym}?events=history&period1=${period1}&period2=${period2}&interval=1wk`

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await fetchJson(url)) as any
  const result = data?.chart?.result?.[0]
  if (!result) return []

  const timestamps: number[] = result.timestamp ?? []
  const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? []

  const prices: WeeklyPrice[] = []
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i]
    if (close == null || isNaN(close)) continue
    prices.push({
      price_date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
      close,
    })
  }
  return prices
}
