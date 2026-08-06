import { describe, expect, it } from 'vitest'
import { measuredRollup, unmeasuredEarned, unmeasuredRollup, type MeasuredRow, type UnmeasuredRow } from './projectedActual'

describe('measuredRollup', () => {
  it('projected is Approximate Quantity x Unit Price, earned is recorded quantity x Unit Price', () => {
    const rows: MeasuredRow[] = [{ approximateQuantity: 1000, quantityToDate: 400, unitPrice: 10 }]
    const r = measuredRollup(rows)
    expect(r.projected).toBe(10000)
    expect(r.earned).toBe(4000)
    expect(r.percent).toBeCloseTo(0.4, 5)
  })

  it('sums across multiple rows', () => {
    const rows: MeasuredRow[] = [
      { approximateQuantity: 1000, quantityToDate: 400, unitPrice: 10 },
      { approximateQuantity: 500, quantityToDate: 500, unitPrice: 20 },
    ]
    const r = measuredRollup(rows)
    expect(r.projected).toBe(10000 + 10000)
    expect(r.earned).toBe(4000 + 10000)
  })

  it('percent can exceed 1 — over-quantity is a gain, not clamped', () => {
    const rows: MeasuredRow[] = [{ approximateQuantity: 100, quantityToDate: 150, unitPrice: 10 }]
    const r = measuredRollup(rows)
    expect(r.percent).toBeCloseTo(1.5, 5)
  })

  it('a row with no Unit Price on file contributes nothing — absent, not zero', () => {
    const rows: MeasuredRow[] = [
      { approximateQuantity: 1000, quantityToDate: 400, unitPrice: 10 },
      { approximateQuantity: 500, quantityToDate: 100, unitPrice: null },
    ]
    const r = measuredRollup(rows)
    expect(r.projected).toBe(10000) // the unpriced row's own contribution is dropped, not summed as 0
    expect(r.earned).toBe(4000)
    expect(r.coverage).toEqual({ count: 1, total: 2 })
  })

  it('is fully absent — not zero — when nothing has a Unit Price', () => {
    const rows: MeasuredRow[] = [{ approximateQuantity: 1000, quantityToDate: 400, unitPrice: null }]
    const r = measuredRollup(rows)
    expect(r.projected).toBeNull()
    expect(r.earned).toBeNull()
    expect(r.percent).toBeNull()
  })

  it('percent is null when projected is 0 (an Approximate Quantity of 0 priced at any rate)', () => {
    const rows: MeasuredRow[] = [{ approximateQuantity: 0, quantityToDate: 0, unitPrice: 10 }]
    const r = measuredRollup(rows)
    expect(r.projected).toBe(0)
    expect(r.percent).toBeNull()
  })

  it('is fully absent for an empty set, not zero', () => {
    const r = measuredRollup([])
    expect(r.projected).toBeNull()
    expect(r.earned).toBeNull()
    expect(r.percent).toBeNull()
    expect(r.coverage).toEqual({ count: 0, total: 0 })
  })
})

describe('unmeasuredEarned', () => {
  it('lump_sum: percentComplete/100 x its own tendered amount', () => {
    expect(unmeasuredEarned({ itemKind: 'lump_sum', tendered: 80000, percentComplete: 45, authorizedValue: null })).toBeCloseTo(36000, 5)
  })

  it('lump_sum: null when percentComplete has not been entered — never 0', () => {
    expect(unmeasuredEarned({ itemKind: 'lump_sum', tendered: 80000, percentComplete: null, authorizedValue: null })).toBeNull()
  })

  it('lump_sum: null when there is no tendered amount either, regardless of percentComplete', () => {
    expect(unmeasuredEarned({ itemKind: 'lump_sum', tendered: null, percentComplete: 100, authorizedValue: null })).toBeNull()
  })

  it('provisional_sum: authorizedValue directly, never prorated against anything', () => {
    expect(unmeasuredEarned({ itemKind: 'provisional_sum', tendered: 150000, percentComplete: null, authorizedValue: 62000 })).toBe(62000)
  })

  it('provisional_sum: null when nothing has been authorized yet', () => {
    expect(unmeasuredEarned({ itemKind: 'provisional_sum', tendered: 150000, percentComplete: null, authorizedValue: null })).toBeNull()
  })

  it('unit_price: always null — this function is never the earned source for a measured Item', () => {
    expect(unmeasuredEarned({ itemKind: 'unit_price', tendered: 1000, percentComplete: 50, authorizedValue: 500 })).toBeNull()
  })
})

describe('unmeasuredRollup', () => {
  it('tendered sums Ext. amount across the group; earned sums per-Item earned', () => {
    const rows: UnmeasuredRow[] = [
      { itemKind: 'lump_sum', tendered: 80000, percentComplete: 50, authorizedValue: null },
      { itemKind: 'provisional_sum', tendered: 150000, percentComplete: null, authorizedValue: 62000 },
    ]
    const r = unmeasuredRollup(rows)
    expect(r.tendered).toBe(80000 + 150000)
    expect(r.earned).toBe(40000 + 62000)
    expect(r.coverage).toEqual({ count: 2, total: 2 })
  })

  it('never computes a percent — the shape itself has no field for one', () => {
    const rows: UnmeasuredRow[] = [{ itemKind: 'lump_sum', tendered: 80000, percentComplete: 50, authorizedValue: null }]
    const r = unmeasuredRollup(rows)
    expect(Object.keys(r)).toEqual(['tendered', 'earned', 'coverage'])
  })

  it('a Lump Sum Item with nothing entered contributes to tendered but not earned — absent, not zero', () => {
    const rows: UnmeasuredRow[] = [{ itemKind: 'lump_sum', tendered: 80000, percentComplete: null, authorizedValue: null }]
    const r = unmeasuredRollup(rows)
    expect(r.tendered).toBe(80000)
    expect(r.earned).toBeNull()
    expect(r.coverage).toEqual({ count: 0, total: 1 })
  })

  it('is fully absent for an empty set', () => {
    const r = unmeasuredRollup([])
    expect(r.tendered).toBeNull()
    expect(r.earned).toBeNull()
    expect(r.coverage).toEqual({ count: 0, total: 0 })
  })
})
