import { describe, expect, it } from 'vitest'
import { remainingDisplay } from './trackerRemaining'

describe('remainingDisplay', () => {
  it('under quantity reads quantityRemaining straight from the view — Venables 04.03.02, Cold Mill 50 mm, Aug 2026', () => {
    // approx 421,100, to date 377,103.02, view's own quantityRemaining 43,996.98.
    expect(remainingDisplay({ approximateQuantity: 421100, quantityToDate: 377103.02, quantityRemaining: 43996.98, isOverQuantity: false })).toEqual({
      isOverQuantity: false,
      amount: 43996.98,
    })
  })

  it('over quantity recovers the magnitude from quantityToDate, not the clamped quantityRemaining — Venables 04.03.01, Milled Tie Ins, Aug 2026', () => {
    // approx 1,200, to date 1,698.75 — 498.75 over. The view's own quantityRemaining is clamped
    // to 0 for this row (greatest(approx - toDate, 0)), so it can't carry the over-amount.
    expect(remainingDisplay({ approximateQuantity: 1200, quantityToDate: 1698.75, quantityRemaining: 0, isOverQuantity: true })).toEqual({
      isOverQuantity: true,
      amount: 498.75,
    })
  })

  it('exactly at Approximate Quantity is under, not over, with zero remaining — Venables 04.06.03', () => {
    expect(remainingDisplay({ approximateQuantity: 60, quantityToDate: 60, quantityRemaining: 0, isOverQuantity: false })).toEqual({
      isOverQuantity: false,
      amount: 0,
    })
  })

  it('nothing recorded yet reads the full Approximate Quantity as remaining', () => {
    expect(remainingDisplay({ approximateQuantity: 53450, quantityToDate: 0, quantityRemaining: 53450, isOverQuantity: false })).toEqual({
      isOverQuantity: false,
      amount: 53450,
    })
  })
})
