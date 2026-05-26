import { fetchNseAnnouncements } from './nse'

async function fetchYahooRaw(symbol: string, suffix: string) {
  const ySym = `${symbol}${suffix}`
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ySym}?events=split&range=max&interval=1mo`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await res.json() as any
  return data?.chart?.result?.[0]?.events?.splits ?? {}
}

function section(title: string) {
  console.log(`\n${'='.repeat(70)}`)
  console.log(`  ${title}`)
  console.log('='.repeat(70))
}

async function run() {

  // ----------------------------------------------------------------
  // Yahoo Finance splits - raw shape
  // ----------------------------------------------------------------
  section('Yahoo Finance - WIPRO splits (raw)')
  const wiproSplits = await fetchYahooRaw('WIPRO', '.NS')
  console.log(JSON.stringify(wiproSplits, null, 2))

  section('Yahoo Finance - HDFCBANK splits (raw)')
  const hdfcSplits = await fetchYahooRaw('HDFCBANK', '.NS')
  console.log(JSON.stringify(hdfcSplits, null, 2))

  // ----------------------------------------------------------------
  // NSE announcements - raw text for merger, name change, symbol change
  // ----------------------------------------------------------------
  section('NSE announcements - HDFCBANK mergers (raw attchmntText)')
  const hdfcAnns = await fetchNseAnnouncements('HDFCBANK')
  const mergers = hdfcAnns.filter(a => a.desc === 'Amalgamation/Merger')
  console.log(`Total merger announcements: ${mergers.length}`)
  mergers.forEach((a, i) => {
    console.log(`\n--- Announcement ${i + 1} ---`)
    console.log('sort_date :', a.sort_date)
    console.log('desc      :', a.desc)
    console.log('text      :', a.attchmntText)
  })

  section('NSE announcements - WIPRO mergers (raw attchmntText)')
  const wiproAnns = await fetchNseAnnouncements('WIPRO')
  const wiproMergers = wiproAnns.filter(a => a.desc === 'Amalgamation/Merger')
  console.log(`Total merger announcements: ${wiproMergers.length}`)
  wiproMergers.forEach((a, i) => {
    console.log(`\n--- Announcement ${i + 1} ---`)
    console.log('sort_date :', a.sort_date)
    console.log('desc      :', a.desc)
    console.log('text      :', a.attchmntText)
  })

  section('NSE announcements - INFY name + symbol changes (raw attchmntText)')
  const infyAnns = await fetchNseAnnouncements('INFY')
  const nameChanges = infyAnns.filter(a => a.desc === 'Company Name Change')
  const symbolChanges = infyAnns.filter(a => a.desc === 'Change in Company Name / Symbol')
  console.log(`Name change announcements: ${nameChanges.length}`)
  nameChanges.forEach((a, i) => {
    console.log(`\n--- Name change ${i + 1} ---`)
    console.log('sort_date :', a.sort_date)
    console.log('text      :', a.attchmntText)
  })
  console.log(`\nSymbol change announcements: ${symbolChanges.length}`)
  symbolChanges.forEach((a, i) => {
    console.log(`\n--- Symbol change ${i + 1} ---`)
    console.log('sort_date :', a.sort_date)
    console.log('text      :', a.attchmntText)
  })

}

run().catch(err => { console.error(err); process.exit(1) })
