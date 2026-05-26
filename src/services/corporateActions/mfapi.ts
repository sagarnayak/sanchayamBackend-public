export type MfNav = {
  price_date: string  // YYYY-MM-DD
  nav: number         // raw float - caller converts to minor units
}

export async function fetchMfNavHistory(schemeCode: string): Promise<MfNav[]> {
  const url = `https://api.mfapi.in/mf/${encodeURIComponent(schemeCode)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`mfapi.in HTTP ${res.status}: ${url}`)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await res.json()) as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const navData: { date: string; nav: string }[] = data?.data ?? []

  return navData
    .map(row => {
      // mfapi dates: "18-05-2026" (DD-MM-YYYY)
      const [d, m, y] = row.date.split('-')
      const isoDate = `${y}-${m}-${d}`
      const nav = parseFloat(row.nav)
      if (isNaN(nav)) return null
      return { price_date: isoDate, nav }
    })
    .filter((x): x is MfNav => x !== null)
    .sort((a, b) => a.price_date.localeCompare(b.price_date))
}
