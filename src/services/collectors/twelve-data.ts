import { DataCollector } from './types'

type PriceEntry = { price?: string; status?: string; message?: string }

export class TwelveDataCollector implements DataCollector {
  name = 'twelve-data'
  private apiKey: string
  private baseUrl: string

  constructor(apiKey: string, baseUrl = 'https://api.twelvedata.com') {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
  }

  async fetchFxRates(currencies: string[]): Promise<Map<string, string>> {
    if (currencies.length === 0) return new Map()

    const symbols = currencies.map(c => `${c}/USD`).join(',')
    const url = `${this.baseUrl}/price?symbol=${encodeURIComponent(symbols)}&apikey=${this.apiKey}`

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`Twelve Data API error: ${res.status} ${res.statusText}`)

    const data = await res.json() as Record<string, unknown>
    const result = new Map<string, string>()

    if (currencies.length === 1) {
      const single = data as PriceEntry
      if (single.status === 'error') throw new Error(single.message ?? 'Unknown API error')
      if (!single.price) throw new Error(`No price returned for ${currencies[0]}`)
      result.set(currencies[0], single.price)
    } else {
      for (const ccy of currencies) {
        const entry = data[`${ccy}/USD`] as PriceEntry | undefined
        if (!entry || entry.status === 'error' || !entry.price) {
          throw new Error(`No price returned for ${ccy}: ${entry?.message ?? 'missing'}`)
        }
        result.set(ccy, entry.price)
      }
    }

    return result
  }
}
