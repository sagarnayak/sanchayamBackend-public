import { AssetAlias, CorporateAction } from './types'

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://www.nseindia.com/',
  'Accept': 'application/json',
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: NSE_HEADERS })
  if (!res.ok) throw new Error(`NSE API HTTP ${res.status}: ${url}`)
  return res.json()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseDate(raw: string): string | null {
  // NSE dates come in various formats: "16-Jun-2011", "2011-06-16", "June 16, 2011"
  if (!raw) return null
  const d = new Date(raw)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  return null
}

function extractEffectiveDate(text: string): string | null {
  // Handles: "DD-Mon-YYYY", "DD/Mon/YYYY", "Month DD, YYYY", "Month DD YYYY"
  const dateFragment = `(?:\\d{1,2}[- /]\\w+[- /]\\d{4}|[A-Za-z]+\\s+\\d{1,2},?\\s+\\d{4})`
  const patterns = [
    new RegExp(`effective\\s+(?:from\\s+)?(${dateFragment})`, 'i'),
    new RegExp(`w\\.e\\.f\\.?\\s+(${dateFragment})`, 'i'),
    new RegExp(`effective\\s+date[:\\s]+(${dateFragment})`, 'i'),
    new RegExp(`(${dateFragment})`),  // fallback: first date-like string
  ]
  for (const pattern of patterns) {
    const m = text.match(pattern)
    if (m) {
      const parsed = parseDate(m[1])
      if (parsed) return parsed
    }
  }
  return null
}

export type NseAnnouncementRaw = {
  desc: string
  attchmntText: string
  bflag: string
  sort_date: string
  symbol: string
}

export async function fetchNseAnnouncements(symbol: string): Promise<NseAnnouncementRaw[]> {
  const url = `https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol)}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await fetchJson(url)) as any[]
  if (!Array.isArray(data)) return []
  return data
}

export function extractNameChanges(announcements: NseAnnouncementRaw[]): AssetAlias[] {
  const relevant = announcements.filter(a => a.desc === 'Company Name Change')
  const aliases: AssetAlias[] = []

  for (const ann of relevant) {
    const text = ann.attchmntText ?? ''
    const effectiveDate = extractEffectiveDate(text) ?? parseDate(ann.sort_date) ?? ''
    if (!effectiveDate) continue

    // Pattern: "change the name of the Company from X to Y. The change is effective..."
    // or: "name changed from X to Y w.e.f. ..."
    const fromMatch = text.match(/name.*?from\s+([A-Z][^.]+?)\s+to\s+([A-Z][^.]+?)(?:\.|,|\s+w\.e\.f|\s+The\s+change|\s+with\s+effect|\s+effective)/i)
    if (fromMatch) {
      aliases.push({
        symbol: ann.symbol,
        name: fromMatch[1].trim(),
        from_date: '2000-01-01',  // unknown start - will be overwritten by prior alias record
        to_date: effectiveDate,
      })
      aliases.push({
        symbol: ann.symbol,
        name: fromMatch[2].trim(),
        from_date: effectiveDate,
        to_date: null,
      })
    }
  }

  return aliases
}

export function extractSymbolChanges(announcements: NseAnnouncementRaw[]): AssetAlias[] {
  const relevant = announcements.filter(a => a.desc === 'Change in Company Name / Symbol')
  const aliases: AssetAlias[] = []

  for (const ann of relevant) {
    const text = ann.attchmntText ?? ''
    const effectiveDate = extractEffectiveDate(text) ?? parseDate(ann.sort_date) ?? ''
    if (!effectiveDate) continue

    // Pattern: "trading symbol of the Company be changed from INFOSYSTCH to INFY w.e.f. ..."
    const fromMatch = text.match(/symbol.*?(?:be\s+)?changed?\s+from\s+(\w+)\s+to\s+(\w+)/i)
    if (fromMatch) {
      aliases.push({
        symbol: fromMatch[1].trim(),
        name: '',  // name unknown from this record alone
        from_date: '2000-01-01',
        to_date: effectiveDate,
      })
      aliases.push({
        symbol: fromMatch[2].trim(),
        name: '',
        from_date: effectiveDate,
        to_date: null,
      })
    }
  }

  return aliases
}

export function extractMergers(announcements: NseAnnouncementRaw[], symbol: string): CorporateAction[] {
  const relevant = announcements.filter(a => a.desc === 'Amalgamation/Merger')
  const actions: CorporateAction[] = []

  // Multiple announcements per merger (proposal -> court order -> effective)
  // We want the effective date - look for announcement mentioning "effective" or "appointed date"
  const effectiveDates: string[] = []
  for (const ann of relevant) {
    const text = ann.attchmntText ?? ''
    const date = extractEffectiveDate(text)
    if (date) effectiveDates.push(date)
  }

  if (effectiveDates.length > 0) {
    // Use the most recent effective date (final completion)
    effectiveDates.sort()
    actions.push({
      action_type: 'merger',
      action_date: effectiveDates[effectiveDates.length - 1],
      ratio_from: null,
      ratio_to: null,
      merged_into_symbol: null,  // counterparty not reliably extractable from text
      notes: `NSE: ${relevant.length} merger announcement(s) found for ${symbol}`,
    })
  }

  return actions
}
