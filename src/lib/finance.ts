export interface CashFlow {
  amount: number
  date: Date
}

// Detects the last point where a holding's running quantity reached zero (full exit).
// Returns only the lots from after that point, so XIRR reflects the current position only.
// If there was never a full exit, returns all lots unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function trimLotsToCurrentPosition(lots: any[]): any[] {
  if (lots.length === 0) return lots
  let runningQty = 0
  let lastExitIdx = -1
  for (let i = 0; i < lots.length; i++) {
    const qty = parseFloat(lots[i].quantity as string)
    if (lots[i].transaction_type === 'buy') runningQty += qty
    else if (lots[i].transaction_type === 'sell') runningQty -= qty
    if (runningQty <= 0 && i < lots.length - 1) {
      lastExitIdx = i
      runningQty = 0
    }
  }
  return lastExitIdx >= 0 ? lots.slice(lastExitIdx + 1) : lots
}

// Under 365 days: absolute return (not annualized). 365+ days: XIRR.
// cashFlows must include terminal value as the last entry (positive amount).
export function computeReturn(cashFlows: CashFlow[]): number | null {
  if (cashFlows.length < 2) return null
  const sorted = [...cashFlows].sort((a, b) => a.date.getTime() - b.date.getTime())
  const spanDays = (sorted[sorted.length - 1].date.getTime() - sorted[0].date.getTime()) / 86400000
  const terminalValue = sorted[sorted.length - 1].amount
  const otherFlows = sorted.slice(0, sorted.length - 1)

  if (spanDays < 365) {
    const totalBuys = otherFlows.filter(cf => cf.amount < 0).reduce((s, cf) => s + Math.abs(cf.amount), 0)
    const totalSells = otherFlows.filter(cf => cf.amount > 0).reduce((s, cf) => s + cf.amount, 0)
    const netInvested = totalBuys - totalSells
    if (netInvested <= 0) return null
    return (terminalValue - netInvested) / netInvested
  }

  const raw = xirr(cashFlows)
  if (raw === null || !isFinite(raw) || Math.abs(raw) > 9999) return null
  return raw
}

export function xirr(cashflows: CashFlow[]): number | null {
  if (cashflows.length < 2) return null
  const hasPos = cashflows.some(c => c.amount > 0)
  const hasNeg = cashflows.some(c => c.amount < 0)
  if (!hasPos || !hasNeg) return null

  const t0 = cashflows[0].date.getTime()
  const yrs = cashflows.map(c => (c.date.getTime() - t0) / (365.25 * 86_400_000))
  const amt = cashflows.map(c => c.amount)

  const npv  = (r: number) => amt.reduce((s, a, i) => s + a / (1 + r) ** yrs[i], 0)
  const dnpv = (r: number) => amt.reduce((s, a, i) => s - yrs[i] * a / (1 + r) ** (yrs[i] + 1), 0)

  for (const guess of [0.1, 0.0, -0.1, 0.5, -0.5, 1.5]) {
    let r = guess
    for (let i = 0; i < 300; i++) {
      const f = npv(r)
      const d = dnpv(r)
      if (!isFinite(f) || !isFinite(d) || Math.abs(d) < 1e-12) break
      const nr = r - f / d
      if (nr <= -1) break
      if (Math.abs(nr - r) < 1e-7) return nr
      r = nr
    }
  }
  return null
}
