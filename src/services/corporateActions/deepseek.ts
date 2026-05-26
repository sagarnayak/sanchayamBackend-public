import { logger } from '../../lib/logger'
import { NseAnnouncementRaw } from './nse'
import { CorporateAction, AssetAlias } from './types'
import { env } from '../../config/env'

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const DEEPSEEK_KEY = env.DEEPSEEK_API_KEY

export type DeepSeekExtracted = {
  name_changes: Array<{
    old_name: string
    new_name: string
    effective_date: string   // YYYY-MM-DD
  }>
  symbol_changes: Array<{
    old_symbol: string
    new_symbol: string
    effective_date: string   // YYYY-MM-DD
  }>
  mergers: Array<{
    effective_date: string   // YYYY-MM-DD
    counterparty: string     // name of the other entity
    direction: 'merged_into_us' | 'we_merged_into'  // who absorbed whom
    is_material: boolean     // false = subsidiary/step-down internal restructuring
    notes: string
  }>
}

const SYSTEM_PROMPT = `You are a financial data extraction engine. You receive a list of NSE (National Stock Exchange India) corporate announcement texts for a single listed company.

Extract all of the following if present:
1. Company name changes - old name, new name, effective date
2. Trading symbol changes - old symbol, new symbol, effective date
3. Mergers/amalgamations - but ONLY ones that are material to the listed entity itself (i.e. another company merged INTO this company, or this company merged INTO another company). Ignore internal subsidiary/step-down restructuring that does not affect the listed entity directly.

For mergers:
- direction "merged_into_us" = another entity was absorbed into this listed company (e.g. HDFC Ltd merged into HDFC Bank)
- direction "we_merged_into" = this listed company was absorbed into another entity (delisting scenario)
- is_material = true only if the listed entity itself is a party to the merger, not just its subsidiaries
- effective_date = the date the merger actually became effective (not announcement date, not NCLT order date). Use the sort_date of the announcement that says the merger is "completed" or "effective". If no explicit effective date exists in the text, use the sort_date of the latest announcement.

Return ONLY a JSON object. No explanation. No markdown. No code fences. Just raw JSON matching this schema exactly:
{
  "name_changes": [{"old_name":"","new_name":"","effective_date":"YYYY-MM-DD"}],
  "symbol_changes": [{"old_symbol":"","new_symbol":"","effective_date":"YYYY-MM-DD"}],
  "mergers": [{"effective_date":"YYYY-MM-DD","counterparty":"","direction":"merged_into_us|we_merged_into","is_material":true,"notes":""}]
}`

async function callDeepSeek(announcements: NseAnnouncementRaw[]): Promise<DeepSeekExtracted> {
  if (!DEEPSEEK_KEY) throw new Error('DEEPSEEK_API_KEY is not configured')
  const input = announcements.map(a => ({
    sort_date: a.sort_date,
    desc: a.desc,
    text: a.attchmntText,
  }))

  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(input) },
      ],
      max_tokens: 2000,
      temperature: 0,
    }),
  })

  if (!res.ok) throw new Error(`DeepSeek API HTTP ${res.status}`)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await res.json() as any
  const content: string = data.choices?.[0]?.message?.content ?? ''

  let parsed: DeepSeekExtracted
  try {
    parsed = JSON.parse(content.trim())
  } catch {
    throw new Error(`DeepSeek returned non-JSON: ${content.slice(0, 200)}`)
  }

  return {
    name_changes:   Array.isArray(parsed.name_changes)   ? parsed.name_changes   : [],
    symbol_changes: Array.isArray(parsed.symbol_changes) ? parsed.symbol_changes : [],
    mergers:        Array.isArray(parsed.mergers)        ? parsed.mergers        : [],
  }
}

export async function extractFromNseAnnouncements(
  symbol: string,
  announcements: NseAnnouncementRaw[]
): Promise<{ actions: CorporateAction[]; aliases: AssetAlias[] }> {

  const relevant = announcements.filter(a =>
    a.desc === 'Company Name Change' ||
    a.desc === 'Change in Company Name / Symbol' ||
    a.desc === 'Amalgamation/Merger'
  )

  if (relevant.length === 0) {
    return { actions: [], aliases: [] }
  }

  logger.info(`[corporateActions] ${symbol}: sending ${relevant.length} NSE announcement(s) to DeepSeek`)

  const extracted = await callDeepSeek(relevant)

  const aliases: AssetAlias[] = []
  const actions: CorporateAction[] = []

  for (const nc of extracted.name_changes) {
    aliases.push({
      symbol,
      name: nc.old_name,
      from_date: '2000-01-01',
      to_date: nc.effective_date,
    })
    aliases.push({
      symbol,
      name: nc.new_name,
      from_date: nc.effective_date,
      to_date: null,
    })
  }

  for (const sc of extracted.symbol_changes) {
    aliases.push({
      symbol: sc.old_symbol,
      name: '',
      from_date: '2000-01-01',
      to_date: sc.effective_date,
    })
    aliases.push({
      symbol: sc.new_symbol,
      name: '',
      from_date: sc.effective_date,
      to_date: null,
    })
  }

  for (const m of extracted.mergers) {
    if (!m.is_material) continue
    actions.push({
      action_type: 'merger',
      action_date: m.effective_date,
      ratio_from: null,
      ratio_to: null,
      merged_into_symbol: null,
      notes: `${m.direction === 'merged_into_us' ? `${m.counterparty} merged into ${symbol}` : `${symbol} merged into ${m.counterparty}`}. ${m.notes}`.trim(),
    })
  }

  return { actions, aliases }
}
