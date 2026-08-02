import { describe, expect, it } from 'vitest'
import { percentComplete, placedToDateByItem } from './lineItemProgress'

describe('placedToDateByItem', () => {
  it('sums multiple rows for the same line item', () => {
    const totals = placedToDateByItem([
      { lineItemId: 'a', quantity: 10 },
      { lineItemId: 'a', quantity: 15 },
    ])
    expect(totals.get('a')).toBe(25)
  })

  it('keeps totals for different line items separate', () => {
    const totals = placedToDateByItem([
      { lineItemId: 'a', quantity: 10 },
      { lineItemId: 'b', quantity: 5 },
    ])
    expect(totals.get('a')).toBe(10)
    expect(totals.get('b')).toBe(5)
  })

  it('returns an empty map for no rows', () => {
    expect(placedToDateByItem([]).size).toBe(0)
  })

  // The scenario daily_entries_effective exists for: an item with a
  // confirmed original (42.5) and a still-draft correction contributes only
  // the original — the aggregation just sums whatever effective rows it's
  // handed, so this is really asserting that a caller who correctly filtered
  // to the effective set gets the right total, not re-testing the filter
  // itself (see effectiveEntries.test.ts for that).
  it('reflects only the effective row when a correction is still under review', () => {
    const totals = placedToDateByItem([{ lineItemId: 'a', quantity: 42.5 }])
    expect(totals.get('a')).toBe(42.5)
  })
})

describe('percentComplete', () => {
  it('computes placed / bidQuantity for a normal unit', () => {
    expect(percentComplete(50, 200, 'Tonne')).toBe(0.25)
  })

  it('is null for a Lump Sum item regardless of bid quantity', () => {
    expect(percentComplete(5, 1, 'Lump Sum')).toBeNull()
  })

  it('is null for a Prov. Sum item', () => {
    expect(percentComplete(0, 1, 'Prov. Sum')).toBeNull()
  })

  it('is null when bid quantity is zero, not a divide-by-zero', () => {
    expect(percentComplete(10, 0, 'Tonne')).toBeNull()
  })

  it('can exceed 1 for an overrun', () => {
    expect(percentComplete(250, 200, 'Tonne')).toBe(1.25)
  })
})
