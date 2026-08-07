import { describe, expect, it } from 'vitest'
import { deriveQuantity, recordContribution, type SourceRecord } from './derivation'

describe('recordContribution', () => {
  it('area basis reads quantity for a quantity_is_area source', () => {
    expect(recordContribution('area', 'quantity_is_area', { quantity: 24150, area: null, stationFrom: null, stationTo: null })).toBe(24150)
  })

  it('area basis reads the area field for a separately_measured source', () => {
    expect(recordContribution('area', 'separately_measured', { quantity: 3150, area: 8714.68, stationFrom: null, stationTo: null })).toBe(8714.68)
  })

  it('area basis is null when a separately_measured source has no area entered yet — never 0', () => {
    expect(recordContribution('area', 'separately_measured', { quantity: 3150, area: null, stationFrom: null, stationTo: null })).toBeNull()
  })

  it('area basis is null for a not_applicable or unclassified source', () => {
    expect(recordContribution('area', 'not_applicable', { quantity: 100, area: null, stationFrom: null, stationTo: null })).toBeNull()
    expect(recordContribution('area', null, { quantity: 100, area: null, stationFrom: null, stationTo: null })).toBeNull()
  })

  it('length basis reads reach regardless of the source Item\'s area_basis', () => {
    // 12+400 to 15+449 = 3049 m — Venables hot joint sealant, July 30.
    expect(recordContribution('length', 'separately_measured', { quantity: 500, area: null, stationFrom: 12.4, stationTo: 15.449 })).toBeCloseTo(3049, 5)
  })

  it('length basis is null when stations are absent', () => {
    expect(recordContribution('length', 'separately_measured', { quantity: 500, area: null, stationFrom: null, stationTo: null })).toBeNull()
  })
})

describe('deriveQuantity', () => {
  it('Venables tack coat, July 29: 0.26 x (8714.68 m2 top lift + 260.00 m2 level course) = 2333.4168 L', () => {
    const areaBasisByItemId = new Map([
      ['top-lift', 'separately_measured' as const],
      ['level-course', 'separately_measured' as const],
    ])
    const records: SourceRecord[] = [
      { itemId: 'top-lift', quantity: 3150, area: 8714.68, stationFrom: null, stationTo: null },
      { itemId: 'level-course', quantity: 260, area: 260.0, stationFrom: null, stationTo: null },
    ]
    const result = deriveQuantity({ coefficient: 0.26, basis: 'area' }, areaBasisByItemId, records)
    expect(result).toBeCloseTo(2333.4168, 4)
  })

  it('Venables hot joint sealant, July 30: 0.08 x 3049 m mainline top lift run = 243.92 L', () => {
    const areaBasisByItemId = new Map([['top-lift', 'separately_measured' as const]])
    const records: SourceRecord[] = [{ itemId: 'top-lift', quantity: 500, area: null, stationFrom: 12.4, stationTo: 15.449 }]
    const result = deriveQuantity({ coefficient: 0.08, basis: 'length' }, areaBasisByItemId, records)
    expect(result).toBeCloseTo(243.92, 2)
  })

  it('Hwy 5 emulsified penetrating primer: ~1.66 x 24150 m2 Job A base preparation is close to the reported 40090 L', () => {
    const areaBasisByItemId = new Map([['base-prep', 'quantity_is_area' as const]])
    const records: SourceRecord[] = [{ itemId: 'base-prep', quantity: 24150, area: null, stationFrom: null, stationTo: null }]
    const result = deriveQuantity({ coefficient: 1.66, basis: 'area' }, areaBasisByItemId, records)
    expect(result).toBeCloseTo(40089, 0)
  })

  it('sums across more than two sources, not just a pair', () => {
    const areaBasisByItemId = new Map([
      ['a', 'separately_measured' as const],
      ['b', 'separately_measured' as const],
      ['c', 'quantity_is_area' as const],
    ])
    const records: SourceRecord[] = [
      { itemId: 'a', quantity: 0, area: 100, stationFrom: null, stationTo: null },
      { itemId: 'b', quantity: 0, area: 200, stationFrom: null, stationTo: null },
      { itemId: 'c', quantity: 300, area: null, stationFrom: null, stationTo: null },
    ]
    const result = deriveQuantity({ coefficient: 2, basis: 'area' }, areaBasisByItemId, records)
    expect(result).toBe(1200)
  })

  it('is null — not 0 — when no source Item has anything recorded that date', () => {
    const result = deriveQuantity({ coefficient: 0.26, basis: 'area' }, new Map(), [])
    expect(result).toBeNull()
  })

  it('a source with nothing recorded drops out; the others still sum', () => {
    const areaBasisByItemId = new Map([
      ['a', 'separately_measured' as const],
      ['b', 'separately_measured' as const],
    ])
    const records: SourceRecord[] = [
      { itemId: 'a', quantity: 0, area: 100, stationFrom: null, stationTo: null },
      { itemId: 'b', quantity: 0, area: null, stationFrom: null, stationTo: null },
    ]
    const result = deriveQuantity({ coefficient: 0.26, basis: 'area' }, areaBasisByItemId, records)
    expect(result).toBeCloseTo(26, 5)
  })
})
