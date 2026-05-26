import { describe, it, expect } from 'vitest'
import { trimLotsToCurrentPosition, computeReturn, xirr } from './finance'

// ---- helpers ----

function lot(type: 'buy' | 'sell', qty: number, date: string, price = 100) {
  return { transaction_type: type, quantity: String(qty), price_per_unit: String(price), transaction_date: date }
}

function days(n: number): Date {
  const d = new Date('2020-01-01')
  d.setDate(d.getDate() + n)
  return d
}

// ---- trimLotsToCurrentPosition ----

describe('trimLotsToCurrentPosition', () => {
  it('returns all lots when there was never a full exit', () => {
    const lots = [lot('buy', 10, '2020-01-01'), lot('buy', 5, '2020-06-01')]
    expect(trimLotsToCurrentPosition(lots)).toEqual(lots)
  })

  it('returns empty array for empty input', () => {
    expect(trimLotsToCurrentPosition([])).toEqual([])
  })

  it('trims to lots after the last full exit', () => {
    const lots = [
      lot('buy', 10, '2020-01-01'),
      lot('sell', 10, '2020-06-01'), // full exit
      lot('buy', 5, '2021-01-01'),   // new position
    ]
    const result = trimLotsToCurrentPosition(lots)
    expect(result).toHaveLength(1)
    expect(result[0].transaction_date).toBe('2021-01-01')
  })

  it('handles multiple full exits - returns only lots after the last one', () => {
    const lots = [
      lot('buy', 10, '2019-01-01'),
      lot('sell', 10, '2019-06-01'), // first full exit
      lot('buy', 5, '2020-01-01'),
      lot('sell', 5, '2020-06-01'),  // second full exit
      lot('buy', 3, '2021-01-01'),   // current position
    ]
    const result = trimLotsToCurrentPosition(lots)
    expect(result).toHaveLength(1)
    expect(result[0].transaction_date).toBe('2021-01-01')
  })

  it('does not trim when the last lot itself reaches zero', () => {
    // Selling down to zero at the very last lot should not trim
    const lots = [
      lot('buy', 10, '2020-01-01'),
      lot('sell', 10, '2020-06-01'), // last lot and reaches zero - no subsequent lots
    ]
    const result = trimLotsToCurrentPosition(lots)
    // The full exit condition only triggers when i < lots.length - 1
    expect(result).toEqual(lots)
  })

  it('handles partial sell - no trim', () => {
    const lots = [
      lot('buy', 10, '2020-01-01'),
      lot('sell', 5, '2020-06-01'), // partial, qty still 5
    ]
    expect(trimLotsToCurrentPosition(lots)).toEqual(lots)
  })

  it('handles fractional quantities', () => {
    const lots = [
      lot('buy', 1.5, '2020-01-01'),
      lot('sell', 1.5, '2020-06-01'), // full exit
      lot('buy', 0.5, '2021-01-01'),
    ]
    const result = trimLotsToCurrentPosition(lots)
    expect(result).toHaveLength(1)
    expect(result[0].transaction_date).toBe('2021-01-01')
  })
})

// ---- computeReturn (short-term absolute return) ----

describe('computeReturn - short-term (< 365 days)', () => {
  it('returns null for fewer than 2 cash flows', () => {
    expect(computeReturn([])).toBeNull()
    expect(computeReturn([{ amount: 100, date: new Date() }])).toBeNull()
  })

  it('computes simple absolute return: 10000 invested, 11000 returned', () => {
    const flows = [
      { amount: -10000, date: days(0) },
      { amount: 11000, date: days(100) },
    ]
    const r = computeReturn(flows)
    expect(r).not.toBeNull()
    expect(r!).toBeCloseTo(0.1, 4)
  })

  it('returns null when net invested is zero or negative', () => {
    // sell > buy (unusual but guard needed)
    const flows = [
      { amount: -1000, date: days(0) },
      { amount: 2000, date: days(10) }, // intermediate sell
      { amount: 500, date: days(50) },  // terminal
    ]
    const r = computeReturn(flows)
    // totalBuys=1000, totalSells=2000, netInvested=-1000 - should return null
    expect(r).toBeNull()
  })

  it('accounts for intermediate sells when computing net invested', () => {
    const flows = [
      { amount: -10000, date: days(0) },   // buy
      { amount: 2000,  date: days(30) },   // partial sell
      { amount: 9000,  date: days(100) },  // terminal value
    ]
    // netInvested = 10000 - 2000 = 8000; return = (9000 - 8000) / 8000 = 0.125
    const r = computeReturn(flows)
    expect(r).not.toBeNull()
    expect(r!).toBeCloseTo(0.125, 4)
  })
})

// ---- computeReturn delegates to xirr for >= 365 days ----

describe('computeReturn - long-term (>= 365 days)', () => {
  it('returns a positive XIRR for a profitable multi-year investment', () => {
    const flows = [
      { amount: -100000, date: new Date('2020-01-01') },
      { amount: 120000,  date: new Date('2022-01-01') }, // 2-year hold, ~10% CAGR
    ]
    const r = computeReturn(flows)
    expect(r).not.toBeNull()
    expect(r!).toBeGreaterThan(0)
    expect(r!).toBeLessThan(1) // sanity: less than 100%/yr
  })

  it('returns null for unreasonably large XIRR (> 9999)', () => {
    // Trivially large return - solver may converge to something > 9999
    // or return null directly from the null guard
    const flows = [
      { amount: -1,     date: new Date('2020-01-01') },
      { amount: 1e8,    date: new Date('2021-06-01') }, // absurd gain
    ]
    const r = computeReturn(flows)
    // Either null (solver failed) or a finite value that passes the > 9999 guard
    if (r !== null) {
      expect(Math.abs(r)).toBeLessThanOrEqual(9999)
    }
  })
})

// ---- xirr ----

describe('xirr', () => {
  it('returns null for fewer than 2 cash flows', () => {
    expect(xirr([])).toBeNull()
    expect(xirr([{ amount: -100, date: new Date() }])).toBeNull()
  })

  it('returns null when all flows are the same sign', () => {
    expect(xirr([
      { amount: 100, date: days(0) },
      { amount: 200, date: days(365) },
    ])).toBeNull()

    expect(xirr([
      { amount: -100, date: days(0) },
      { amount: -200, date: days(365) },
    ])).toBeNull()
  })

  it('solves a simple annual return case', () => {
    // Invest 1000, get 1100 after exactly one year - XIRR should be ~10%
    const flows = [
      { amount: -1000, date: new Date('2020-01-01') },
      { amount: 1100,  date: new Date('2021-01-01') },
    ]
    const r = xirr(flows)
    expect(r).not.toBeNull()
    expect(r!).toBeCloseTo(0.1, 2)
  })

  it('solves with multiple buy lots', () => {
    const flows = [
      { amount: -5000, date: new Date('2020-01-01') },
      { amount: -5000, date: new Date('2020-07-01') },
      { amount: 12000, date: new Date('2022-01-01') },
    ]
    const r = xirr(flows)
    expect(r).not.toBeNull()
    expect(r!).toBeGreaterThan(0)
  })

  it('returns a negative value for a losing investment', () => {
    const flows = [
      { amount: -10000, date: new Date('2020-01-01') },
      { amount: 7000,   date: new Date('2022-01-01') },
    ]
    const r = xirr(flows)
    expect(r).not.toBeNull()
    expect(r!).toBeLessThan(0)
  })
})
