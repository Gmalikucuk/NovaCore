import { describe, expect, it } from 'vitest'
import { claimFieldForKind, percentOfApproximate, projectedValueVariance, proposeClaimedFromRecords, quantityToDate, variance } from './progressEstimates'

describe('claimFieldForKind', () => {
  it('is quantity for unit_price', () => {
    expect(claimFieldForKind('unit_price')).toBe('quantity')
  })

  it('is percent for lump_sum', () => {
    expect(claimFieldForKind('lump_sum')).toBe('percent')
  })

  it('is value for provisional_sum', () => {
    expect(claimFieldForKind('provisional_sum')).toBe('value')
  })
})

describe('proposeClaimedFromRecords', () => {
  it('is empty for no records — nothing to propose, not a zero-quantity line', () => {
    expect(proposeClaimedFromRecords([], '2026-06-01', '2026-06-30', new Map())).toEqual([])
  })

  it('sums quantity per item within the period, priced at the item’s unit price', () => {
    const records = [
      { itemId: 'a', workDate: '2026-06-05', quantity: 100 },
      { itemId: 'a', workDate: '2026-06-12', quantity: 50 },
    ]
    const proposed = proposeClaimedFromRecords(records, '2026-06-01', '2026-06-30', new Map([['a', 10]]))
    expect(proposed).toEqual([{ itemId: 'a', claimedQuantity: 150, claimedValue: 1500 }])
  })

  it('excludes records outside the period, inclusive of both boundary dates', () => {
    const records = [
      { itemId: 'a', workDate: '2026-05-31', quantity: 999 },
      { itemId: 'a', workDate: '2026-06-01', quantity: 10 },
      { itemId: 'a', workDate: '2026-06-30', quantity: 20 },
      { itemId: 'a', workDate: '2026-07-01', quantity: 999 },
    ]
    const proposed = proposeClaimedFromRecords(records, '2026-06-01', '2026-06-30', new Map([['a', 1]]))
    expect(proposed).toEqual([{ itemId: 'a', claimedQuantity: 30, claimedValue: 30 }])
  })

  it('keeps items separate', () => {
    const records = [
      { itemId: 'a', workDate: '2026-06-05', quantity: 100 },
      { itemId: 'b', workDate: '2026-06-06', quantity: 5 },
    ]
    const proposed = proposeClaimedFromRecords(records, '2026-06-01', '2026-06-30', new Map([['a', 10], ['b', 20]]))
    expect(proposed).toContainEqual({ itemId: 'a', claimedQuantity: 100, claimedValue: 1000 })
    expect(proposed).toContainEqual({ itemId: 'b', claimedQuantity: 5, claimedValue: 100 })
  })

  it('claimedValue is null when the item has no known unit price — absent, not a $0 line', () => {
    const records = [{ itemId: 'a', workDate: '2026-06-05', quantity: 100 }]
    const proposed = proposeClaimedFromRecords(records, '2026-06-01', '2026-06-30', new Map([['a', null]]))
    expect(proposed).toEqual([{ itemId: 'a', claimedQuantity: 100, claimedValue: null }])
  })

  it('claimedValue is null when the item is absent from the price map entirely', () => {
    const records = [{ itemId: 'a', workDate: '2026-06-05', quantity: 100 }]
    const proposed = proposeClaimedFromRecords(records, '2026-06-01', '2026-06-30', new Map())
    expect(proposed).toEqual([{ itemId: 'a', claimedQuantity: 100, claimedValue: null }])
  })
})

describe('variance', () => {
  it('is certified minus claimed', () => {
    expect(variance(100, 90)).toBe(-10)
    expect(variance(100, 110)).toBe(10)
    expect(variance(100, 100)).toBe(0)
  })

  it('is null when claimed is unknown', () => {
    expect(variance(null, 90)).toBeNull()
  })

  it('is null when certified is unknown — not yet certified reads as absent, not zero', () => {
    expect(variance(100, null)).toBeNull()
  })

  it('is null when both are unknown', () => {
    expect(variance(null, null)).toBeNull()
  })

  it('does not clamp a negative variance — a shortfall is the gap, not an error', () => {
    expect(variance(200, 50)).toBe(-150)
  })
})

describe('quantityToDate', () => {
  it('is previous plus current', () => {
    expect(quantityToDate(100, 50)).toBe(150)
  })

  it('treats a null previous as zero — no prior claim exists', () => {
    expect(quantityToDate(null, 50)).toBe(50)
  })

  it('is null when current is unknown, even with a real previous', () => {
    expect(quantityToDate(100, null)).toBeNull()
  })

  it('is null when both are unknown', () => {
    expect(quantityToDate(null, null)).toBeNull()
  })
})

describe('percentOfApproximate', () => {
  it('is quantity over approximate quantity, as a percent', () => {
    expect(percentOfApproximate(50, 200)).toBe(25)
  })

  it('does not clamp over 100% — a gain, not a fault (GC 52.04)', () => {
    expect(percentOfApproximate(631.4, 120)).toBeCloseTo(526.17, 1)
  })

  it('is null when the quantity is unknown', () => {
    expect(percentOfApproximate(null, 200)).toBeNull()
  })

  it('is null when approximate quantity is zero or negative', () => {
    expect(percentOfApproximate(50, 0)).toBeNull()
  })
})

describe('projectedValueVariance', () => {
  it('is (projected - approximate) times unit price — a gain when projected exceeds tender', () => {
    expect(projectedValueVariance(150, 120, 100)).toBe(3000)
  })

  it('is negative when projected falls short of tender — the gap, not clamped', () => {
    expect(projectedValueVariance(100, 120, 100)).toBe(-2000)
  })

  it('is null when projected quantity is not yet entered', () => {
    expect(projectedValueVariance(null, 120, 100)).toBeNull()
  })

  it('is null when unit price is unknown', () => {
    expect(projectedValueVariance(150, 120, null)).toBeNull()
  })
})
