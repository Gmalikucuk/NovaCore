import { describe, expect, it } from 'vitest'
import { bidItemCost, bidItemExtended, bidItemMargin, costCoverage, sumOrNull } from './bidValue'

describe('bidItemExtended', () => {
  it('scales with quantity', () => {
    expect(bidItemExtended(100, 12.5)).toBeCloseTo(1250, 5)
  })

  it('is null when sellPrice is missing — not zero', () => {
    expect(bidItemExtended(100, null)).toBeNull()
  })

  it('is zero when quantity is zero but a price is set', () => {
    expect(bidItemExtended(0, 12.5)).toBe(0)
  })
})

describe('bidItemCost', () => {
  it('scales with quantity', () => {
    expect(bidItemCost(100, 8)).toBe(800)
  })

  it('is null when costPrice is missing', () => {
    expect(bidItemCost(100, null)).toBeNull()
  })
})

describe('bidItemMargin', () => {
  it('is extended minus cost when both are known', () => {
    expect(bidItemMargin(100, 12.5, 8)).toBeCloseTo(450, 5)
  })

  it('is null when sellPrice is missing', () => {
    expect(bidItemMargin(100, null, 8)).toBeNull()
  })

  it('is null when costPrice is missing — never assumes zero cost', () => {
    expect(bidItemMargin(100, 12.5, null)).toBeNull()
  })
})

describe('sumOrNull', () => {
  it('sums the known values', () => {
    expect(sumOrNull([100, null, 50])).toBe(150)
  })

  it('is null when every value is null — not zero', () => {
    expect(sumOrNull([null, null])).toBeNull()
  })

  it('is null for an empty array', () => {
    expect(sumOrNull([])).toBeNull()
  })
})

describe('costCoverage', () => {
  it('counts lines by cost source, and uncosted separately', () => {
    const lines = [{ costSource: 'judgement' as const }, { costSource: 'judgement' as const }, { costSource: 'vendor_quote' as const }, { costSource: null }]
    expect(costCoverage(lines)).toEqual({ vendorQuote: 1, judgement: 2, calculatedBuild: 0, uncosted: 1 })
  })

  it('is all zero for an empty bid', () => {
    expect(costCoverage([])).toEqual({ vendorQuote: 0, judgement: 0, calculatedBuild: 0, uncosted: 0 })
  })
})
