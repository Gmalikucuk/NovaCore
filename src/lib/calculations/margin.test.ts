import { describe, expect, it } from 'vitest'
import { margin, marginPercent } from './margin'

describe('margin', () => {
  it('computes quantity * (sell - cost)', () => {
    expect(margin(100, 88.5, 112)).toBeCloseTo(2350, 5)
  })

  it('is null when cost is missing', () => {
    expect(margin(100, null, 112)).toBeNull()
  })

  it('is null when sell is missing', () => {
    expect(margin(100, 88.5, null)).toBeNull()
  })

  it('can be negative — a rate entered backwards should show as a loss, not be hidden', () => {
    expect(margin(100, 112, 88.5)).toBeCloseTo(-2350, 5)
  })

  it('is 0 at zero quantity even when priced', () => {
    expect(margin(0, 88.5, 112)).toBe(0)
  })
})

describe('marginPercent', () => {
  it('computes (sell - cost) / sell', () => {
    expect(marginPercent(100, 88.5, 112)).toBeCloseTo(0.2098, 3)
  })

  it('is null when either rate is missing', () => {
    expect(marginPercent(100, null, 112)).toBeNull()
    expect(marginPercent(100, 88.5, null)).toBeNull()
  })

  it('is null at zero quantity, not a misleadingly-computable percentage', () => {
    expect(marginPercent(0, 88.5, 112)).toBeNull()
  })

  it('is null when sell price is zero (avoids a divide-by-zero)', () => {
    expect(marginPercent(100, 5, 0)).toBeNull()
  })

  it('matches margin / revenue algebraically', () => {
    const quantity = 250
    const cost = 4.2
    const sell = 6.75
    const m = margin(quantity, cost, sell)!
    const revenue = quantity * sell
    expect(marginPercent(quantity, cost, sell)).toBeCloseTo(m / revenue, 10)
  })
})
