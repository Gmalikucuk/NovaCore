import { describe, expect, it } from 'vitest'
import { aggregateFinancials, reconcileTenderPrice, rowFinancials, type RowFinancialsInput } from './bidSummary'

function unitPriceInput(overrides: Partial<RowFinancialsInput> = {}): RowFinancialsInput {
  return {
    itemKind: 'unit_price',
    approximateQuantity: 100,
    provisionalSum: null,
    costPrice: 68.5,
    costBasis: 'per_unit',
    unitPrice: 87.2,
    ...overrides,
  }
}

describe('rowFinancials — unit_price', () => {
  it('extends cost and amount by quantity', () => {
    const r = rowFinancials(unitPriceInput({ approximateQuantity: 21400, costPrice: 23.4, unitPrice: 29.85 }))
    expect(r.extCost).toBeCloseTo(21400 * 23.4, 5)
    expect(r.extAmount).toBeCloseTo(21400 * 29.85, 5)
  })

  it('is MARGIN, not markup — the brief\'s own Top Lift Job B figures: $87.20 price, $68.50 cost', () => {
    const r = rowFinancials(unitPriceInput({ approximateQuantity: 100, costPrice: 68.5, unitPrice: 87.2 }))
    // margin: (87.20 - 68.50) / 87.20 = 21.4%
    expect(r.marginPercent).toBeCloseTo(0.214, 3)
    // NOT markup, which would read 27.3% — (87.20 - 68.50) / 68.50
    expect(r.marginPercent).not.toBeCloseTo(0.273, 3)
  })

  it('a total-basis Unit Price Item ignores quantity for cost, like Lump Sum does', () => {
    const r = rowFinancials(unitPriceInput({ approximateQuantity: 16000, costPrice: 80000, costBasis: 'total', unitPrice: 5 }))
    expect(r.extCost).toBe(80000)
    expect(r.extAmount).toBe(80000)
    expect(r.margin).toBeCloseTo(16000 * 5 - 80000, 5)
  })

  it('is unpriced (all null) when neither cost nor price is entered', () => {
    const r = rowFinancials(unitPriceInput({ costPrice: null, costBasis: null, unitPrice: null }))
    expect(r).toEqual({ extCost: null, extAmount: null, margin: null, marginPercent: null })
  })

  it('extCost alone does not produce a margin — a missing price is not a zero price', () => {
    const r = rowFinancials(unitPriceInput({ unitPrice: null }))
    expect(r.extCost).not.toBeNull()
    expect(r.extAmount).toBeNull()
    expect(r.margin).toBeNull()
  })
})

describe('rowFinancials — lump_sum', () => {
  it('the stored figures ARE the extended figures — never multiplied by quantity', () => {
    const r = rowFinancials({
      itemKind: 'lump_sum',
      approximateQuantity: 1,
      provisionalSum: null,
      costPrice: 38000,
      costBasis: 'total',
      unitPrice: 52000,
    })
    expect(r.extCost).toBe(38000)
    expect(r.extAmount).toBe(52000)
    expect(r.margin).toBe(14000)
  })

  it('extAmount is taken directly regardless of approximate_quantity — Schedule 7 gives Lump Sum no reliable quantity to trust', () => {
    const r = rowFinancials({
      itemKind: 'lump_sum',
      approximateQuantity: 0,
      provisionalSum: null,
      costPrice: 38000,
      costBasis: 'total',
      unitPrice: 52000,
    })
    expect(r.extAmount).toBe(52000)
  })

  it('unpriced Lump Sum is all null', () => {
    const r = rowFinancials({ itemKind: 'lump_sum', approximateQuantity: 1, provisionalSum: null, costPrice: null, costBasis: null, unitPrice: null })
    expect(r).toEqual({ extCost: null, extAmount: null, margin: null, marginPercent: null })
  })
})

describe('rowFinancials — provisional_sum', () => {
  it('Ext. amount comes from provisionalSum, never item_prices', () => {
    const r = rowFinancials({
      itemKind: 'provisional_sum',
      approximateQuantity: 1,
      provisionalSum: 150000,
      costPrice: 999, // present in item_prices but must be ignored entirely
      costBasis: 'total',
      unitPrice: 999,
    })
    expect(r.extAmount).toBe(150000)
    expect(r.extCost).toBeNull()
    expect(r.margin).toBeNull()
    expect(r.marginPercent).toBeNull()
  })

  it('margin is null, never 0, even when provisionalSum is a real number', () => {
    const r = rowFinancials({ itemKind: 'provisional_sum', approximateQuantity: 1, provisionalSum: 5000, costPrice: null, costBasis: null, unitPrice: null })
    expect(r.margin).toBeNull()
  })

  it('Ext. amount is null when provisional_sum itself was never entered on the Item', () => {
    const r = rowFinancials({ itemKind: 'provisional_sum', approximateQuantity: 1, provisionalSum: null, costPrice: null, costBasis: null, unitPrice: null })
    expect(r.extAmount).toBeNull()
  })
})

describe('aggregateFinancials', () => {
  const rows = [
    { itemKind: 'unit_price' as const, financials: rowFinancials(unitPriceInput({ approximateQuantity: 100, costPrice: 50, unitPrice: 80 })) }, // extCost 5000, extAmount 8000, margin 3000
    { itemKind: 'unit_price' as const, financials: rowFinancials(unitPriceInput({ approximateQuantity: 100, costPrice: null, costBasis: null, unitPrice: 80 })) }, // uncosted: extAmount 8000, cost/margin null
    { itemKind: 'lump_sum' as const, financials: rowFinancials({ itemKind: 'lump_sum', approximateQuantity: 1, provisionalSum: null, costPrice: 38000, costBasis: 'total', unitPrice: 52000 }) }, // margin 14000
    { itemKind: 'provisional_sum' as const, financials: rowFinancials({ itemKind: 'provisional_sum', approximateQuantity: 1, provisionalSum: 85000, costPrice: null, costBasis: null, unitPrice: null }) },
  ]

  it('Ext. amount sums every row including provisional_sum, with no coverage note attached', () => {
    const agg = aggregateFinancials(rows)
    expect(agg.extAmountSum).toBe(8000 + 8000 + 52000 + 85000)
  })

  it('cost and margin exclude provisional_sum from both the sum and the coverage denominator', () => {
    const agg = aggregateFinancials(rows)
    expect(agg.extCostSum).toBe(5000 + 38000)
    expect(agg.costCoverage).toEqual({ count: 2, total: 3 }) // 3 cost-applicable rows (2 unit_price + 1 lump_sum), 2 actually costed
    expect(agg.marginSum).toBe(3000 + 14000)
    expect(agg.marginCoverage).toEqual({ count: 2, total: 3 })
  })

  it('margin percent is blended against the margin-applicable rows\' own revenue, not the grand Ext. amount (provisional_sum excluded)', () => {
    const agg = aggregateFinancials(rows)
    // margin-applicable revenue: 8000 (row1) + 8000 (row2, uncosted but priced) + 52000 (lump sum) = 68000
    expect(agg.marginPercent).toBeCloseTo(17000 / 68000, 5)
  })

  it('is all-null/zero-coverage for an empty row set, never a bare 0', () => {
    const agg = aggregateFinancials([])
    expect(agg.extCostSum).toBeNull()
    expect(agg.extAmountSum).toBeNull()
    expect(agg.marginSum).toBeNull()
    expect(agg.marginPercent).toBeNull()
    expect(agg.costCoverage).toEqual({ count: 0, total: 0 })
  })
})

describe('reconcileTenderPrice', () => {
  it('matches when the sum equals the tender price exactly', () => {
    const r = reconcileTenderPrice(15739126.37, 15739126.37)
    expect(r.matches).toBe(true)
    expect(r.differenceCents).toBe(0)
  })

  it('matches despite float drift, since comparison happens in cents', () => {
    // 0.1 + 0.2 style drift — sums built from many decimal additions can land
    // a fraction of a cent off in floating point even when correct to the cent.
    const sum = Array.from({ length: 3 }, () => 0.1).reduce((a, b) => a + b, 15739126.07)
    const r = reconcileTenderPrice(sum, 15739126.37)
    expect(r.matches).toBe(true)
  })

  it('diverges and states the signed difference in cents when the sum is over', () => {
    const r = reconcileTenderPrice(15739226.37, 15739126.37)
    expect(r.matches).toBe(false)
    expect(r.differenceCents).toBe(10000) // $100.00 over
  })

  it('diverges when the sum is under', () => {
    const r = reconcileTenderPrice(15739026.37, 15739126.37)
    expect(r.matches).toBe(false)
    expect(r.differenceCents).toBe(-10000)
  })
})
