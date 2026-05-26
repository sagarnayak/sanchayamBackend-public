import { resolveCorporateActions, fetchWeeklyPrices, fetchMfNavHistory } from './index'

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${title}`)
  console.log('='.repeat(60))
}

function summarisePrices(prices: { price_date: string; close?: number; nav?: number }[]) {
  if (!prices.length) { console.log('  No prices returned'); return }
  console.log(`  Total data points : ${prices.length}`)
  console.log(`  Oldest            : ${prices[0].price_date}  ->  ${prices[0].close ?? prices[0].nav}`)
  console.log(`  Latest            : ${prices[prices.length - 1].price_date}  ->  ${prices[prices.length - 1].close ?? prices[prices.length - 1].nav}`)
}

async function run() {

  // ----------------------------------------------------------------
  // 1. WIPRO - India equity with name changes, splits, bonuses
  // ----------------------------------------------------------------
  section('WIPRO - India equity (name changes + splits + bonuses)')
  const wipro = await resolveCorporateActions({
    asset_id: 'test-wipro',
    symbol: 'WIPRO',
    name: 'Wipro Limited',
    exchange: 'NSE',
    data_type: 'equity_india',
    earliest_date: '2000-01-01',
  })
  console.log(`  Corporate actions : ${wipro.actions.length}`)
  wipro.actions.forEach(a => console.log(`    [${a.action_date}] ${a.action_type}  ratio ${a.ratio_from}:${a.ratio_to}  ${a.notes ?? ''}`))
  console.log(`  Aliases           : ${wipro.aliases.length}`)
  wipro.aliases.forEach(a => console.log(`    ${a.from_date} -> ${a.to_date ?? 'now'}  symbol=${a.symbol}  name="${a.name}"`))
  console.log(`  Pre-2003 gap      : ${wipro.pre2003_gap}`)

  const wiproPrices = await fetchWeeklyPrices('WIPRO', 'NSE')
  summarisePrices(wiproPrices)

  // ----------------------------------------------------------------
  // 2. HDFCBANK - merger (HDFC Ltd merged in July 2023)
  // ----------------------------------------------------------------
  section('HDFCBANK - India equity (merger)')
  const hdfc = await resolveCorporateActions({
    asset_id: 'test-hdfcbank',
    symbol: 'HDFCBANK',
    name: 'HDFC Bank Limited',
    exchange: 'NSE',
    data_type: 'equity_india',
    earliest_date: '2010-01-01',
  })
  console.log(`  Corporate actions : ${hdfc.actions.length}`)
  hdfc.actions.forEach(a => console.log(`    [${a.action_date}] ${a.action_type}  ${a.notes ?? ''}`))
  console.log(`  Aliases           : ${hdfc.aliases.length}`)
  hdfc.aliases.forEach(a => console.log(`    ${a.from_date} -> ${a.to_date ?? 'now'}  symbol=${a.symbol}  name="${a.name}"`))

  const hdfcPrices = await fetchWeeklyPrices('HDFCBANK', 'NSE')
  summarisePrices(hdfcPrices)

  // ----------------------------------------------------------------
  // 3. NVDA - US equity with recent splits (4:1 in 2021, 10:1 in 2024)
  // ----------------------------------------------------------------
  section('NVDA - US equity (splits)')
  const nvda = await resolveCorporateActions({
    asset_id: 'test-nvda',
    symbol: 'NVDA',
    name: 'NVIDIA Corporation',
    exchange: 'NASDAQ',
    data_type: 'equity_us',
    earliest_date: '2015-01-01',
  })
  console.log(`  Corporate actions : ${nvda.actions.length}`)
  nvda.actions.forEach(a => console.log(`    [${a.action_date}] ${a.action_type}  ratio ${a.ratio_from}:${a.ratio_to}`))

  const nvdaPrices = await fetchWeeklyPrices('NVDA', 'NASDAQ')
  summarisePrices(nvdaPrices)

  // ----------------------------------------------------------------
  // 4. Indian MF - SBI Bluechip Fund (scheme 125497)
  // ----------------------------------------------------------------
  section('SBI Bluechip Fund - India mutual fund NAV history')
  const sbiNavs = await fetchMfNavHistory('125497')
  summarisePrices(sbiNavs.map(n => ({ price_date: n.price_date, nav: n.nav })))

}

run().catch(err => { console.error(err); process.exit(1) })
