import { describe, expect, it } from 'vitest'
import type { ItemProgressRate } from '../supabase/monthlyPeriods'
import { buildProblemList, classifyProblem, formatMonthLabel, itemsInProgress, monthDirection, monthKeyFromDate, monthKeyToPeriod, previousMonth, weightedCompletion } from './overview'

function row(overrides: Partial<ItemProgressRate>): ItemProgressRate {
  return {
    itemId: 'i1',
    contractId: 'c1',
    itemNumber: '01.01',
    description: 'Test item',
    unit: 'Tonne',
    itemKind: 'unit_price',
    approximateQuantity: 1000,
    quantityToDate: 100,
    proportionComplete: 0.1,
    quantityRemaining: 900,
    quantityLast30: 50,
    workingDaysLast30: 5,
    lastWorkDate: '2026-08-01',
    quantityPerWorkingDay: 10,
    workingDaysRemaining: 10,
    isStalled: false,
    isOverQuantity: false,
    ...overrides,
  }
}

describe('month arithmetic', () => {
  it('reads year/month from a Date', () => {
    expect(monthKeyFromDate(new Date(2026, 7, 15))).toEqual({ year: 2026, month: 8 })
  })

  it('steps back a month within a year', () => {
    expect(previousMonth({ year: 2026, month: 8 })).toEqual({ year: 2026, month: 7 })
  })

  it('rolls over a year boundary — January to December of the prior year', () => {
    expect(previousMonth({ year: 2026, month: 1 })).toEqual({ year: 2025, month: 12 })
  })

  it('formats a period string matching period_month (always the 1st, zero-padded)', () => {
    expect(monthKeyToPeriod({ year: 2026, month: 8 })).toBe('2026-08-01')
    expect(monthKeyToPeriod({ year: 2026, month: 1 })).toBe('2026-01-01')
  })

  it('formats a human label', () => {
    expect(formatMonthLabel({ year: 2026, month: 8 })).toBe('August 2026')
  })
})

describe('weightedCompletion', () => {
  it('weights by quantity, not a count or average of per-item percentages', () => {
    // Item A: 100/10,000 (1%). Item B: 900/1,000 (90%). A simple average of
    // percentages would read ~45.5%; weighted by quantity it's ~9.1%
    // (1,000 of 11,000) — the number that actually reflects the contract.
    const result = weightedCompletion([
      { approximateQuantity: 10000, quantityToDate: 100 },
      { approximateQuantity: 1000, quantityToDate: 900 },
    ])
    expect(result).toBeCloseTo(1000 / 11000, 5)
  })

  it('is null when there is no approximate quantity to weight against', () => {
    expect(weightedCompletion([])).toBeNull()
    expect(weightedCompletion([{ approximateQuantity: 0, quantityToDate: 0 }])).toBeNull()
  })

  it('lets an over-quantity item pull the aggregate, uncapped', () => {
    const result = weightedCompletion([{ approximateQuantity: 100, quantityToDate: 150 }])
    expect(result).toBeCloseTo(1.5, 5)
  })
})

describe('itemsInProgress', () => {
  it('counts items started (quantity > 0) but not yet finished (quantity < approximate)', () => {
    const result = itemsInProgress([
      { quantityToDate: 0, approximateQuantity: 100 }, // not started
      { quantityToDate: 50, approximateQuantity: 100 }, // in progress
      { quantityToDate: 100, approximateQuantity: 100 }, // finished exactly
      { quantityToDate: 150, approximateQuantity: 100 }, // over quantity — not "in progress"
    ])
    expect(result).toEqual({ started: 1, total: 4 })
  })

  it('reports total as the full row count regardless of state', () => {
    expect(itemsInProgress([])).toEqual({ started: 0, total: 0 })
  })
})

describe('monthDirection', () => {
  it('reports up, down, or flat', () => {
    expect(monthDirection(100, 50)).toBe('up')
    expect(monthDirection(50, 100)).toBe('down')
    expect(monthDirection(50, 50)).toBe('flat')
  })
})

describe('classifyProblem', () => {
  it('is null for a healthy item', () => {
    expect(classifyProblem(row({}))).toBeNull()
  })

  it('is stalled when is_stalled is set, regardless of anything else', () => {
    expect(classifyProblem(row({ isStalled: true, isOverQuantity: true }))).toBe('stalled')
  })

  it('is over_quantity when is_over_quantity is set and not stalled', () => {
    expect(classifyProblem(row({ isOverQuantity: true }))).toBe('over_quantity')
  })

  it('is behind_rate only past the threshold', () => {
    expect(classifyProblem(row({ workingDaysRemaining: 30 }))).toBeNull()
    expect(classifyProblem(row({ workingDaysRemaining: 31 }))).toBe('behind_rate')
  })

  it('is null when working_days_remaining is null (no rate to project from)', () => {
    expect(classifyProblem(row({ workingDaysRemaining: null }))).toBeNull()
  })
})

describe('buildProblemList', () => {
  const now = new Date('2026-08-15T12:00:00')

  it('groups by kind in order — over quantity (largest cost exposure first), then behind rate, then stalled', () => {
    const rows = [
      row({ itemId: 'behind', workingDaysRemaining: 50 }),
      row({ itemId: 'over', isOverQuantity: true }),
      row({ itemId: 'stalled', isStalled: true }),
    ]
    const list = buildProblemList(rows, now)
    expect(list.map((p) => p.kind)).toEqual(['over_quantity', 'behind_rate', 'stalled'])
  })

  it('excludes healthy items entirely', () => {
    const rows = [row({ itemId: 'healthy' })]
    expect(buildProblemList(rows, now)).toEqual([])
  })

  it('sorts stalled items worst-first — longest idle first', () => {
    const rows = [
      row({ itemId: 'idle-5', isStalled: true, lastWorkDate: '2026-08-10' }),
      row({ itemId: 'idle-30', isStalled: true, lastWorkDate: '2026-07-16' }),
    ]
    const list = buildProblemList(rows, now)
    expect(list.map((p) => p.row.itemId)).toEqual(['idle-30', 'idle-5'])
  })

  it('sorts over-quantity items worst-first — largest overage first', () => {
    const rows = [
      row({ itemId: 'small-over', isOverQuantity: true, approximateQuantity: 100, quantityToDate: 110 }),
      row({ itemId: 'big-over', isOverQuantity: true, approximateQuantity: 100, quantityToDate: 200 }),
    ]
    const list = buildProblemList(rows, now)
    expect(list.map((p) => p.row.itemId)).toEqual(['big-over', 'small-over'])
  })

  it('sorts behind-rate items worst-first — most working days remaining first', () => {
    const rows = [
      row({ itemId: 'closer', workingDaysRemaining: 35 }),
      row({ itemId: 'farther', workingDaysRemaining: 90 }),
    ]
    const list = buildProblemList(rows, now)
    expect(list.map((p) => p.row.itemId)).toEqual(['farther', 'closer'])
  })
})
