import { describe, expect, it } from 'vitest'
import { isOutlier, median, prospectiveOverage } from './confirmations'

describe('prospectiveOverage', () => {
  it('is the amount over Approximate Quantity a plain new entry would cause', () => {
    const overage = prospectiveOverage({ quantity: 50, originalQuantity: null }, { quantityToDate: 980, approximateQuantity: 1000 })
    expect(overage).toBe(30)
  })

  it('is zero or negative when the record would not push the item over', () => {
    expect(prospectiveOverage({ quantity: 10, originalQuantity: null }, { quantityToDate: 980, approximateQuantity: 1000 })).toBe(-10)
  })

  it('subtracts the original confirmed quantity for a correction — the near-complete-item false positive', () => {
    // An item at 995/1000 gets a correction from 995 -> 994 (a 1-unit typo
    // fix). Without subtracting the original, 995 + 994 = 1989 reads as
    // wildly over quantity — but the correction only nets -1.
    const overage = prospectiveOverage({ quantity: 994, originalQuantity: 995 }, { quantityToDate: 995, approximateQuantity: 1000 })
    expect(overage).toBe(-6) // 995 + 994 - 995 - 1000
  })

  it('treats an unconfirmed original as contributing nothing (nothing to subtract)', () => {
    const overage = prospectiveOverage({ quantity: 50, originalQuantity: null }, { quantityToDate: 960, approximateQuantity: 1000 })
    expect(overage).toBe(10)
  })
})

describe('median', () => {
  it('is the middle value for an odd-length list', () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  it('averages the two middle values for an even-length list', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
})

describe('isOutlier', () => {
  it('never flags with fewer than 3 recent records — no baseline is better than a fake one', () => {
    expect(isOutlier(9000, [])).toBe(false)
    expect(isOutlier(9000, [900])).toBe(false)
    expect(isOutlier(9000, [900, 950])).toBe(false)
  })

  it('flags a quantity more than 3x the median once there are at least 3 recent records', () => {
    expect(isOutlier(9000, [900, 950, 1000])).toBe(true)
  })

  it('does not flag a quantity within 3x the median', () => {
    expect(isOutlier(2000, [900, 950, 1000])).toBe(false)
  })
})
