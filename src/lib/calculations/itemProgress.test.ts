import { describe, expect, it } from 'vitest'
import { percentComplete, placedToDateByItem } from './itemProgress'

describe('placedToDateByItem', () => {
  it('sums multiple rows for the same item', () => {
    const totals = placedToDateByItem([
      { itemId: 'a', quantity: 10 },
      { itemId: 'a', quantity: 15 },
    ])
    expect(totals.get('a')).toBe(25)
  })

  it('keeps totals for different items separate', () => {
    const totals = placedToDateByItem([
      { itemId: 'a', quantity: 10 },
      { itemId: 'b', quantity: 5 },
    ])
    expect(totals.get('a')).toBe(10)
    expect(totals.get('b')).toBe(5)
  })

  it('returns an empty map for no rows', () => {
    expect(placedToDateByItem([]).size).toBe(0)
  })

  // The scenario quantity_records_effective exists for: an item with a
  // confirmed original (42.5) and a still-draft correction contributes only
  // the original — the aggregation just sums whatever effective rows it's
  // handed, so this is really asserting that a caller who correctly filtered
  // to the effective set gets the right total, not re-testing the filter
  // itself (see effectiveEntries.test.ts for that).
  it('reflects only the effective row when a correction is still under review', () => {
    const totals = placedToDateByItem([{ itemId: 'a', quantity: 42.5 }])
    expect(totals.get('a')).toBe(42.5)
  })
})

describe('percentComplete', () => {
  it('computes placed / approximateQuantity for a unit_price item', () => {
    expect(percentComplete(50, 200, 'unit_price')).toBe(0.25)
  })

  it('is null for a lump_sum item regardless of approximate quantity', () => {
    expect(percentComplete(5, 1, 'lump_sum')).toBeNull()
  })

  it('is null for a provisional_sum item', () => {
    expect(percentComplete(0, 1, 'provisional_sum')).toBeNull()
  })

  it('is null when approximate quantity is zero, not a divide-by-zero', () => {
    expect(percentComplete(10, 0, 'unit_price')).toBeNull()
  })

  it('can exceed 1 for an overrun', () => {
    expect(percentComplete(250, 200, 'unit_price')).toBe(1.25)
  })
})
