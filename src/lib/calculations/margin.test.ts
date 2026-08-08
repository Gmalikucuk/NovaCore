import { describe, expect, it } from 'vitest'
import { costTrackingVisible, estimatedCost, gateOnCostTracking, margin, marginPercent, sumOrNull } from './margin'

describe('estimatedCost', () => {
  it('scales with quantity when per_unit', () => {
    expect(estimatedCost(100, 88.5, 'per_unit')).toBeCloseTo(8850, 5)
  })

  it('ignores quantity entirely when total — a flat figure, not a rate', () => {
    expect(estimatedCost(100, 80000, 'total')).toBe(80000)
    expect(estimatedCost(0, 80000, 'total')).toBe(80000)
  })

  it('is null when cost is missing', () => {
    expect(estimatedCost(100, null, 'per_unit')).toBeNull()
  })

  it('is null when basis is missing, even with a cost present', () => {
    expect(estimatedCost(100, 88.5, null)).toBeNull()
  })
})

describe('margin', () => {
  it('computes quantity * sell - estimatedCost() for a per_unit rate', () => {
    expect(margin(100, 88.5, 112, 'per_unit')).toBeCloseTo(2350, 5)
  })

  it('uses the flat total directly for a total basis, not scaled by quantity', () => {
    // 20,000 t approximate quantity, 16,000 t actually placed, $80,000
    // quoted for the whole scope: cost must stay $80,000 regardless of
    // how much of the approximation was placed — the exact case this
    // shape exists to get right (0023).
    expect(margin(16000, 80000, 5, 'total')).toBeCloseTo(16000 * 5 - 80000, 5)
  })

  it('is null when cost is missing', () => {
    expect(margin(100, null, 112, 'per_unit')).toBeNull()
  })

  it('is null when basis is missing', () => {
    expect(margin(100, 88.5, 112, null)).toBeNull()
  })

  it('is null when sell is missing', () => {
    expect(margin(100, 88.5, null, 'per_unit')).toBeNull()
  })

  it('can be negative — a rate entered backwards should show as a loss, not be hidden', () => {
    expect(margin(100, 112, 88.5, 'per_unit')).toBeCloseTo(-2350, 5)
  })

  it('is 0 at zero quantity even when priced, per_unit', () => {
    expect(margin(0, 88.5, 112, 'per_unit')).toBe(0)
  })

  it('is negative at zero quantity for a total basis — the cost was still incurred', () => {
    expect(margin(0, 80000, 5, 'total')).toBe(-80000)
  })
})

describe('marginPercent', () => {
  it('computes margin / revenue for a per_unit rate', () => {
    expect(marginPercent(100, 88.5, 112, 'per_unit')).toBeCloseTo(0.2098, 3)
  })

  it('computes margin / revenue for a total basis too', () => {
    const quantity = 16000
    const sell = 5
    const totalCost = 80000
    const revenue = quantity * sell
    expect(marginPercent(quantity, totalCost, sell, 'total')).toBeCloseTo((revenue - totalCost) / revenue, 10)
  })

  it('is null when cost, basis, or sell is missing', () => {
    expect(marginPercent(100, null, 112, 'per_unit')).toBeNull()
    expect(marginPercent(100, 88.5, 112, null)).toBeNull()
    expect(marginPercent(100, 88.5, null, 'per_unit')).toBeNull()
  })

  it('is null at zero quantity, not a misleadingly-computable percentage', () => {
    expect(marginPercent(0, 88.5, 112, 'per_unit')).toBeNull()
  })

  it('is null when sell price is zero (avoids a divide-by-zero)', () => {
    expect(marginPercent(100, 5, 0, 'per_unit')).toBeNull()
  })

  it('matches margin / revenue algebraically', () => {
    const quantity = 250
    const cost = 4.2
    const sell = 6.75
    const m = margin(quantity, cost, sell, 'per_unit')!
    const revenue = quantity * sell
    expect(marginPercent(quantity, cost, sell, 'per_unit')).toBeCloseTo(m / revenue, 10)
  })
})

describe('costTrackingVisible', () => {
  it('is visible when cost tracking is on, regardless of set_cost', () => {
    expect(costTrackingVisible({ costTrackingEnabled: true, setCost: false })).toBe(true)
    expect(costTrackingVisible({ costTrackingEnabled: true, setCost: true })).toBe(true)
  })

  it('is visible when tracking is off but the seat holds set_cost — the entry surface exemption', () => {
    expect(costTrackingVisible({ costTrackingEnabled: false, setCost: true })).toBe(true)
  })

  it('is not visible when tracking is off and the seat holds no set_cost', () => {
    expect(costTrackingVisible({ costTrackingEnabled: false, setCost: false })).toBe(false)
  })
})

describe('gateOnCostTracking', () => {
  it('passes the value through when cost tracking is on', () => {
    expect(gateOnCostTracking(2350, true)).toBe(2350)
    expect(gateOnCostTracking(0, true)).toBe(0)
  })

  it('nulls the value when cost tracking is off, even a real 0', () => {
    expect(gateOnCostTracking(2350, false)).toBeNull()
    expect(gateOnCostTracking(0, false)).toBeNull()
  })

  it('a null value stays null either way', () => {
    expect(gateOnCostTracking(null, true)).toBeNull()
    expect(gateOnCostTracking(null, false)).toBeNull()
  })
})

describe('sumOrNull', () => {
  it('is null when every value is null — nothing priced yet, not a zero total', () => {
    expect(sumOrNull([null, null, null])).toBeNull()
  })

  it('is null for an empty list', () => {
    expect(sumOrNull([])).toBeNull()
  })

  it('sums only the known values, ignoring nulls — a partially priced contract still totals', () => {
    expect(sumOrNull([100, null, 50, null])).toBe(150)
  })

  it('sums all values when none are null', () => {
    expect(sumOrNull([10, 20, 30])).toBe(60)
  })

  it('is a real 0 when the priced rows actually net to zero, not absent', () => {
    expect(sumOrNull([50, -50])).toBe(0)
  })
})
