export type ActionType = 'split' | 'bonus' | 'merger' | 'delisting'

export type CorporateAction = {
  action_type: ActionType
  action_date: string        // YYYY-MM-DD
  ratio_from: number | null  // for split/bonus
  ratio_to: number | null    // for split/bonus
  merged_into_symbol: string | null  // for merger
  notes: string | null
}

export type AssetAlias = {
  symbol: string
  name: string
  from_date: string   // YYYY-MM-DD
  to_date: string | null
}

export type CorporateActionsResult = {
  asset_id: string
  actions: CorporateAction[]
  aliases: AssetAlias[]
  pre2003_gap: boolean  // true if any data before 2003 was needed but unavailable
}
