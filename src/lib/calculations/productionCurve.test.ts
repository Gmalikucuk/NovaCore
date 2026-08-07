import { describe, expect, it } from 'vitest'
import { cumulativeSeries, dateRange, datePercent, dateTicks, quantityRange, quantityPercent, productionFigures, ratePerWorkingDay, hasEnoughWorkingDaysForRate, MIN_WORKING_DAYS_FOR_RATE } from './productionCurve'

describe('cumulativeSeries', () => {
  it('is empty for no records — nothing to draw, not a zero-height chart', () => {
    expect(cumulativeSeries([])).toEqual([])
  })

  it('runs a total forward across ascending dates', () => {
    const series = cumulativeSeries([
      { workDate: '2026-06-15', quantity: 100 },
      { workDate: '2026-06-16', quantity: 50 },
      { workDate: '2026-06-20', quantity: 25 },
    ])
    expect(series).toEqual([
      { date: '2026-06-15', cumulative: 100 },
      { date: '2026-06-16', cumulative: 150 },
      { date: '2026-06-20', cumulative: 175 },
    ])
  })

  it('sums same-day records together rather than producing two points for one date', () => {
    const series = cumulativeSeries([
      { workDate: '2026-06-15', quantity: 60 },
      { workDate: '2026-06-15', quantity: 40 },
    ])
    expect(series).toEqual([{ date: '2026-06-15', cumulative: 100 }])
  })

  it('sorts out-of-order input by date before accumulating', () => {
    const series = cumulativeSeries([
      { workDate: '2026-06-20', quantity: 10 },
      { workDate: '2026-06-15', quantity: 5 },
    ])
    expect(series).toEqual([
      { date: '2026-06-15', cumulative: 5 },
      { date: '2026-06-20', cumulative: 15 },
    ])
  })

  it('the real Venables Top Lift shape: a June record then a nine-day gap before more work — the gap produces no intermediate point, only the two real dates', () => {
    const series = cumulativeSeries([
      { workDate: '2026-06-27', quantity: 1178.02 },
      { workDate: '2026-07-06', quantity: 2073.8 },
    ])
    expect(series.map((p) => p.date)).toEqual(['2026-06-27', '2026-07-06'])
    expect(series[1].cumulative).toBeCloseTo(3251.82, 5)
  })
})

describe('dateRange', () => {
  it('is null for no points', () => {
    expect(dateRange([])).toBeNull()
  })

  it('spans the earliest to the latest date present', () => {
    expect(dateRange([{ date: '2026-06-20' }, { date: '2026-06-15' }, { date: '2026-07-01' }])).toEqual({ loDate: '2026-06-15', hiDate: '2026-07-01' })
  })

  it('a single point is a degenerate (zero-width) range, not an error', () => {
    expect(dateRange([{ date: '2026-06-15' }])).toEqual({ loDate: '2026-06-15', hiDate: '2026-06-15' })
  })
})

describe('datePercent', () => {
  it('maps the low end to 0% and the high end to 100%', () => {
    const range = { loDate: '2026-06-01', hiDate: '2026-06-11' }
    expect(datePercent(range, '2026-06-01')).toBe(0)
    expect(datePercent(range, '2026-06-11')).toBe(100)
    expect(datePercent(range, '2026-06-06')).toBe(50)
  })

  it('a degenerate single-day range maps its one date to 0%, not NaN', () => {
    const range = { loDate: '2026-06-01', hiDate: '2026-06-01' }
    expect(datePercent(range, '2026-06-01')).toBe(0)
  })
})

describe('dateTicks', () => {
  it('never produces a tick before loDate or after hiDate', () => {
    const range = { loDate: '2026-06-08', hiDate: '2026-08-04' }
    const ticks = dateTicks(range)
    expect(ticks.every((t) => t >= range.loDate && t <= range.hiDate)).toBe(true)
  })

  it('does not force a tick exactly at hiDate — stops at the last step that fits, same as the ribbon, so the endpoint caption (drawn separately) is never crowded against a ladder tick', () => {
    const range = { loDate: '2026-06-08', hiDate: '2026-08-06' }
    const ticks = dateTicks(range)
    expect(ticks[ticks.length - 1]).not.toBe(range.hiDate)
  })

  it('uses a coarser step for a long span than a short one', () => {
    const longTicks = dateTicks({ loDate: '2026-06-01', hiDate: '2026-08-04' })
    const shortTicks = dateTicks({ loDate: '2026-06-01', hiDate: '2026-06-08' })
    expect(longTicks.length).toBeLessThan(shortTicks.length * 3)
    expect(shortTicks.length).toBeGreaterThan(2)
  })
})

describe('quantityRange', () => {
  it('is 0 to the Approximate Quantity (plus headroom) when the curve stays under it', () => {
    const range = quantityRange([{ cumulative: 100 }, { cumulative: 300 }], 1000)
    expect(range.lo).toBe(0)
    expect(range.hi).toBeGreaterThan(1000)
    expect(range.hi).toBeCloseTo(1080, 5)
  })

  it('is 0 to the curve\'s own peak (plus headroom) when the curve runs over the Approximate Quantity — the real Venables case (05.03.03, 435.94 of 300)', () => {
    const range = quantityRange([{ cumulative: 435.94 }], 300)
    expect(range.hi).toBeGreaterThan(435.94)
    expect(range.hi).toBeCloseTo(435.94 * 1.08, 5)
  })

  it('never produces a zero-height range for an all-zero series', () => {
    const range = quantityRange([{ cumulative: 0 }], 0)
    expect(range.hi).toBeGreaterThan(0)
  })
})

describe('quantityPercent', () => {
  it('maps the low end to 0% and the high end to 100%', () => {
    const range = { lo: 0, hi: 200 }
    expect(quantityPercent(range, 0)).toBe(0)
    expect(quantityPercent(range, 200)).toBe(100)
    expect(quantityPercent(range, 100)).toBe(50)
  })
})

describe('productionFigures', () => {
  it('is null for no records — nothing to state', () => {
    expect(productionFigures([], 1000)).toBeNull()
  })

  it('working days is the point count, quantity to date is the last cumulative, remaining is signed', () => {
    const points = [{ cumulative: 100 }, { cumulative: 250 }, { cumulative: 400 }]
    expect(productionFigures(points, 1000)).toEqual({ quantityToDate: 400, workingDays: 3, remaining: 600 })
  })

  it('remaining goes negative — a surplus, not clamped to zero — when the Item is over Approximate Quantity', () => {
    const points = [{ cumulative: 435.94 }]
    expect(productionFigures(points, 300)!.remaining).toBeCloseTo(-135.94, 5)
  })

  it('the real Venables Top Lift numbers (05.03.02): 32 working days, 48,129.82 to date, 2,520.18 remaining', () => {
    const points = Array.from({ length: 32 }, (_, i) => ({ cumulative: i === 31 ? 48129.82 : 0 }))
    const figures = productionFigures(points, 50650)!
    expect(figures.workingDays).toBe(32)
    expect(figures.quantityToDate).toBeCloseTo(48129.82, 2)
    expect(figures.remaining).toBeCloseTo(2520.18, 2)
  })
})

describe('ratePerWorkingDay', () => {
  it('divides quantity to date by working days', () => {
    expect(ratePerWorkingDay({ quantityToDate: 100, workingDays: 4 })).toBe(25)
  })

  it('the real Venables Cold Mill rate (04.03.02): 377,103.02 over 35 working days', () => {
    expect(ratePerWorkingDay({ quantityToDate: 377103.02, workingDays: 35 })).toBeCloseTo(10774.37, 2)
  })
})

describe('hasEnoughWorkingDaysForRate', () => {
  it('is false below the threshold', () => {
    expect(hasEnoughWorkingDaysForRate(MIN_WORKING_DAYS_FOR_RATE - 1)).toBe(false)
  })

  it('is true at exactly the threshold — inclusive, a thin sample is not a forbidden one', () => {
    expect(hasEnoughWorkingDaysForRate(MIN_WORKING_DAYS_FOR_RATE)).toBe(true)
  })

  it('is true well above the threshold', () => {
    expect(hasEnoughWorkingDaysForRate(32)).toBe(true)
  })

  it('the real Venables Top Lift Side Roads case (05.03.03) sits exactly at the threshold: 5 working days, still gets a rate', () => {
    expect(hasEnoughWorkingDaysForRate(5)).toBe(true)
  })
})
