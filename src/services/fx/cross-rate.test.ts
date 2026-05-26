import { describe, it, expect } from 'vitest'
import Big from 'big.js'

// The FX service stores all rates vs the USD pivot.
// Cross-rate derivation: rate(from -> to) = rateVsUSD(from) / rateVsUSD(to)
// This is the exact formula used in getRate() in index.ts.

function crossRate(fromVsUsd: string, toVsUsd: string): string {
  return new Big(fromVsUsd).div(new Big(toVsUsd)).toFixed(18)
}

describe('FX cross-rate derivation', () => {
  it('same currency returns 1', () => {
    // getRate short-circuits before computing, but the math holds
    expect(crossRate('1', '1')).toBe('1.000000000000000000')
  })

  it('USD -> INR: 1 USD buys ~85 INR', () => {
    // INR vs USD rate (how many USD per 1 INR): 1/85 ≈ 0.011764...
    const inrVsUsd = new Big(1).div(new Big(85)).toFixed(18)
    const usdVsUsd = '1'
    const result = crossRate(usdVsUsd, inrVsUsd)
    expect(parseFloat(result)).toBeCloseTo(85, 6)
  })

  it('INR -> USD: ~0.01176', () => {
    const inrVsUsd = new Big(1).div(new Big(85)).toFixed(18)
    const result = crossRate(inrVsUsd, '1')
    expect(parseFloat(result)).toBeCloseTo(1 / 85, 6)
  })

  it('cross-rate between two non-pivot currencies (EUR and INR)', () => {
    // EUR vs USD = 1.1 (1 EUR = 1.1 USD)
    // INR vs USD = 1/85 (1 INR = 0.01176 USD)
    // EUR -> INR = 1.1 / (1/85) = 1.1 * 85 = 93.5
    const eurVsUsd = '1.1'
    const inrVsUsd = new Big(1).div(new Big(85)).toFixed(18)
    const result = crossRate(eurVsUsd, inrVsUsd)
    expect(parseFloat(result)).toBeCloseTo(93.5, 4)
  })

  it('inverse cross-rate is the reciprocal', () => {
    const eurVsUsd = '1.1'
    const gbpVsUsd = '1.27'
    const eurToGbp = parseFloat(crossRate(eurVsUsd, gbpVsUsd))
    const gbpToEur = parseFloat(crossRate(gbpVsUsd, eurVsUsd))
    expect(eurToGbp * gbpToEur).toBeCloseTo(1, 8)
  })

  it('crypto cross-rate (BTC vs USD = 65000)', () => {
    const btcVsUsd = '65000'
    const ethVsUsd = '3500'
    // BTC -> ETH = 65000 / 3500 ≈ 18.571
    const result = crossRate(btcVsUsd, ethVsUsd)
    expect(parseFloat(result)).toBeCloseTo(65000 / 3500, 4)
  })

  it('produces 18 decimal places of precision', () => {
    const result = crossRate('1.1', '1.0')
    expect(result.split('.')[1]).toHaveLength(18)
  })
})
