import { describe, expect, it } from 'vitest'
import type { Item } from '../supabase/items'
import type { ItemProgressRate } from '../supabase/monthlyPeriods'
import type { ItemPrice } from '../supabase/prices'
import {
  buildAttention,
  buildProblemList,
  classifyProblem,
  contractCountsToward,
  contractNeedsStalledSuppression,
  contractParticipatesInProduction,
  contractStateFigureChanges,
  contractStateStalledChange,
  coverageNote,
  DEFAULT_OVERVIEW_PREFERENCES,
  figureCoverage,
  formatMonthLabel,
  itemsInProgress,
  moneyMakerRow,
  monthDirection,
  monthKeyFromDate,
  monthKeyToPeriod,
  overQuantityValueAboveSchedule,
  pipelineFigures,
  previousMonth,
  sanitizeOverviewPreferences,
} from './overview'

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

describe('contractNeedsStalledSuppression', () => {
  it('is false only for active — the one state where a quiet Item is a real problem', () => {
    expect(contractNeedsStalledSuppression('active')).toBe(false)
  })
  it('is true for every other state, regardless of any date', () => {
    expect(contractNeedsStalledSuppression('pipeline')).toBe(true)
    expect(contractNeedsStalledSuppression('warranty_period')).toBe(true)
    expect(contractNeedsStalledSuppression('closed_out')).toBe(true)
    expect(contractNeedsStalledSuppression('archived')).toBe(true)
  })
})

describe('contractCountsToward', () => {
  it('pipeline: contract value and backlog, not earned', () => {
    expect(contractCountsToward('contractValue', 'pipeline')).toBe(true)
    expect(contractCountsToward('backlog', 'pipeline')).toBe(true)
    expect(contractCountsToward('earned', 'pipeline')).toBe(false)
  })

  it('active: every figure', () => {
    expect(contractCountsToward('contractValue', 'active')).toBe(true)
    expect(contractCountsToward('earned', 'active')).toBe(true)
    expect(contractCountsToward('backlog', 'active')).toBe(true)
  })

  it('warranty_period: every figure, same as active', () => {
    expect(contractCountsToward('contractValue', 'warranty_period')).toBe(true)
    expect(contractCountsToward('earned', 'warranty_period')).toBe(true)
    expect(contractCountsToward('backlog', 'warranty_period')).toBe(true)
  })

  it('closed_out: earned only — finished work is not pipeline and has no backlog', () => {
    expect(contractCountsToward('earned', 'closed_out')).toBe(true)
    expect(contractCountsToward('contractValue', 'closed_out')).toBe(false)
    expect(contractCountsToward('backlog', 'closed_out')).toBe(false)
  })

  it('archived: no figure', () => {
    expect(contractCountsToward('contractValue', 'archived')).toBe(false)
    expect(contractCountsToward('earned', 'archived')).toBe(false)
    expect(contractCountsToward('backlog', 'archived')).toBe(false)
  })
})

describe('contractParticipatesInProduction', () => {
  it('is false only for pipeline — nothing has started, so there is no production to rank and no schedule to be behind on', () => {
    expect(contractParticipatesInProduction('pipeline')).toBe(false)
  })
  it('is true for every other state', () => {
    expect(contractParticipatesInProduction('active')).toBe(true)
    expect(contractParticipatesInProduction('warranty_period')).toBe(true)
    expect(contractParticipatesInProduction('closed_out')).toBe(true)
    expect(contractParticipatesInProduction('archived')).toBe(true)
  })
})

describe('contractStateFigureChanges', () => {
  const amounts = { contractValue: 1000, earned: 400, backlog: 600 }

  it('active -> warranty_period: no figure changes — both count toward all three identically', () => {
    expect(contractStateFigureChanges('active', 'warranty_period', amounts)).toEqual([])
  })

  it('pipeline -> active: gains earned only (was already in contract value and backlog)', () => {
    expect(contractStateFigureChanges('pipeline', 'active', amounts)).toEqual([{ figure: 'earned', gains: true, amount: 400 }])
  })

  it('active -> closed_out: leaves contract value and backlog, stays in earned (the brief\'s own example)', () => {
    const changes = contractStateFigureChanges('active', 'closed_out', amounts)
    expect(changes).toContainEqual({ figure: 'contractValue', gains: false, amount: 1000 })
    expect(changes).toContainEqual({ figure: 'backlog', gains: false, amount: 600 })
    expect(changes.find((c) => c.figure === 'earned')).toBeUndefined()
  })

  it('closed_out -> archived: leaves earned only', () => {
    expect(contractStateFigureChanges('closed_out', 'archived', amounts)).toEqual([{ figure: 'earned', gains: false, amount: 400 }])
  })

  it('carries this contract\'s own amount, not a company total, including null when absent', () => {
    const changes = contractStateFigureChanges('pipeline', 'closed_out', { contractValue: null, earned: null, backlog: null })
    expect(changes.every((c) => c.amount === null)).toBe(true)
  })

  it('is empty when the state does not actually change', () => {
    expect(contractStateFigureChanges('active', 'active', amounts)).toEqual([])
  })
})

describe('contractStateStalledChange', () => {
  it('turns off when leaving active', () => {
    expect(contractStateStalledChange('active', 'warranty_period')).toBe('turns_off')
  })

  it('turns on when returning to active', () => {
    expect(contractStateStalledChange('closed_out', 'active')).toBe('turns_on')
  })

  it('is unchanged between two non-active states', () => {
    expect(contractStateStalledChange('pipeline', 'closed_out')).toBe('unchanged')
    expect(contractStateStalledChange('warranty_period', 'archived')).toBe('unchanged')
  })

  it('is unchanged when the state does not actually change', () => {
    expect(contractStateStalledChange('active', 'active')).toBe('unchanged')
  })
})

describe('figureCoverage', () => {
  it('counts eligible-by-state separately from has-data', () => {
    const rows = [
      { state: 'active' as const, hasData: true },
      { state: 'active' as const, hasData: false }, // eligible, missing data
      { state: 'pipeline' as const, hasData: true }, // not eligible for 'earned'
      { state: 'archived' as const, hasData: true }, // not eligible for anything
    ]
    expect(figureCoverage('earned', rows)).toEqual({ count: 1, eligible: 2, total: 4 })
  })

  it('is fully complete when every row is eligible and has data', () => {
    const rows = [
      { state: 'active' as const, hasData: true },
      { state: 'warranty_period' as const, hasData: true },
    ]
    expect(figureCoverage('contractValue', rows)).toEqual({ count: 2, eligible: 2, total: 2 })
  })
})

describe('coverageNote', () => {
  it('says nothing when the figure is complete', () => {
    expect(coverageNote({ count: 3, eligible: 3, total: 3 }, 'have no value recorded yet')).toBeNull()
  })

  it('says nothing when there are no real contracts at all', () => {
    expect(coverageNote({ count: 0, eligible: 0, total: 0 }, 'have no value recorded yet')).toBeNull()
  })

  it('states a state-exclusion gap on its own', () => {
    expect(coverageNote({ count: 2, eligible: 2, total: 3 }, 'have no tender price on file yet')).toBe('Covers 2 of 3 real contracts — 1 excluded by contract state')
  })

  it('states a missing-data gap on its own', () => {
    expect(coverageNote({ count: 2, eligible: 3, total: 3 }, 'have no tender price on file yet')).toBe('Covers 2 of 3 real contracts — 1 have no tender price on file yet')
  })

  it('states both gaps together, distinctly, when a figure has each kind', () => {
    expect(coverageNote({ count: 2, eligible: 4, total: 5 }, 'have no tender price on file yet')).toBe(
      'Covers 2 of 5 real contracts — 1 excluded by contract state, 2 have no tender price on file yet',
    )
  })
})

describe('buildAttention', () => {
  const now = new Date('2026-08-15T12:00:00')

  it('separates over-quantity from behind-rate/stalled into two lists', () => {
    const rows = [row({ itemId: 'over', isOverQuantity: true }), row({ itemId: 'behind', workingDaysRemaining: 50 }), row({ itemId: 'stalled', isStalled: true })]
    const result = buildAttention(rows, now, false)
    expect(result.overQuantity.map((p) => p.row.itemId)).toEqual(['over'])
    expect(result.problems.map((p) => p.kind)).toEqual(['behind_rate', 'stalled'])
    expect(result.suppressedStalledCount).toBe(0)
  })

  it('suppresses stalled rows on a finished contract, counting them instead of dropping them silently', () => {
    const rows = [row({ itemId: 'stalled-1', isStalled: true }), row({ itemId: 'stalled-2', isStalled: true }), row({ itemId: 'behind', workingDaysRemaining: 50 })]
    const result = buildAttention(rows, now, true)
    expect(result.problems.map((p) => p.row.itemId)).toEqual(['behind'])
    expect(result.suppressedStalledCount).toBe(2)
  })

  it('over-quantity is never suppressed by a finished contract — it is not stalled detection', () => {
    const rows = [row({ itemId: 'over', isOverQuantity: true })]
    const result = buildAttention(rows, now, true)
    expect(result.overQuantity).toHaveLength(1)
  })
})

describe('overQuantityValueAboveSchedule', () => {
  it('sums (quantityToDate - approximateQuantity) * unitPrice across the group', () => {
    const rows = [
      { kind: 'over_quantity' as const, row: row({ itemId: 'a', approximateQuantity: 100, quantityToDate: 150 }) },
      { kind: 'over_quantity' as const, row: row({ itemId: 'b', approximateQuantity: 200, quantityToDate: 210 }) },
    ]
    const priceByItem = new Map<string, ItemPrice>([
      ['a', { itemId: 'a', costPrice: null, costBasis: null, unitPrice: 10, updatedBy: null, updatedAt: '' }],
      ['b', { itemId: 'b', costPrice: null, costBasis: null, unitPrice: 20, updatedBy: null, updatedAt: '' }],
    ])
    // (150-100)*10 + (210-200)*20 = 500 + 200 = 700
    expect(overQuantityValueAboveSchedule(rows, priceByItem)).toBe(700)
  })

  it('is null when no row in the group has a Unit Price on file', () => {
    const rows = [{ kind: 'over_quantity' as const, row: row({ itemId: 'a' }) }]
    expect(overQuantityValueAboveSchedule(rows, new Map())).toBeNull()
  })
})

describe('pipelineFigures', () => {
  it('computes backlog and percent when both contract value and earned are known', () => {
    const f = pipelineFigures(1000, 400)
    expect(f).toEqual({ contractValue: 1000, earned: 400, backlog: 600, percent: 0.4 })
  })

  it('backlog and percent are null when contract value is unknown', () => {
    const f = pipelineFigures(null, 400)
    expect(f.backlog).toBeNull()
    expect(f.percent).toBeNull()
    expect(f.earned).toBe(400)
  })

  it('backlog is null when earned is unknown, even with a real contract value', () => {
    const f = pipelineFigures(1000, null)
    expect(f.backlog).toBeNull()
    expect(f.percent).toBeNull()
  })
})

describe('moneyMakerRow', () => {
  function item(overrides: Partial<Item>): Item {
    return {
      id: 'i1',
      contractId: 'c1',
      itemNumber: '01.01',
      description: 'Test',
      unit: 'Tonne',
      approximateQuantity: 100,
      itemKind: 'unit_price',
      provisionalSum: null,
      percentComplete: null,
      authorizedValue: null,
      ...overrides,
    }
  }
  function price(overrides: Partial<ItemPrice>): ItemPrice {
    return { itemId: 'i1', costPrice: null, costBasis: null, unitPrice: null, updatedBy: null, updatedAt: '', ...overrides }
  }

  it('a unit_price Item carries real quantity/percent/value-earned figures', () => {
    const r = moneyMakerRow({
      contractId: 'c1',
      contractLabel: 'Test Contract',
      contractState: 'active',
      item: item({ approximateQuantity: 100 }),
      price: price({ unitPrice: 10 }),
      progress: { ...row({ quantityToDate: 40, approximateQuantity: 100 }) },
    })
    expect(r.quantityToDate).toBe(40)
    expect(r.quantityPercent).toBeCloseTo(0.4, 5)
    expect(r.valueEarned).toBe(400)
    expect(r.valueTendered).toBe(1000) // 100 * 10
  })

  it('a Lump Sum Item has null quantity/percent/value-earned — absent, not zero — but a real tendered value', () => {
    const r = moneyMakerRow({
      contractId: 'c1',
      contractLabel: 'Test Contract',
      contractState: 'active',
      item: item({ itemKind: 'lump_sum', approximateQuantity: 1 }),
      price: price({ unitPrice: 52000 }),
      progress: undefined,
    })
    expect(r.quantityToDate).toBeNull()
    expect(r.quantityPercent).toBeNull()
    expect(r.valueEarned).toBeNull()
    expect(r.valueTendered).toBe(52000)
  })

  it('a Provisional Sum Item is valued from provisionalSum, never item_prices', () => {
    const r = moneyMakerRow({
      contractId: 'c1',
      contractLabel: 'Test Contract',
      contractState: 'active',
      item: item({ itemKind: 'provisional_sum', approximateQuantity: 1, provisionalSum: 150000 }),
      price: price({ unitPrice: 999 }),
      progress: undefined,
    })
    expect(r.valueTendered).toBe(150000)
    expect(r.quantityToDate).toBeNull()
  })
})

describe('sanitizeOverviewPreferences', () => {
  it('returns every default when given null (no row saved yet)', () => {
    expect(sanitizeOverviewPreferences(null)).toEqual(DEFAULT_OVERVIEW_PREFERENCES)
  })

  it('returns every default when given an empty object', () => {
    expect(sanitizeOverviewPreferences({})).toEqual(DEFAULT_OVERVIEW_PREFERENCES)
  })

  it('accepts a fully valid blob as-is', () => {
    const valid = {
      marginOn: true,
      pipelineSortKey: 'backlog',
      pipelineSortDir: 'asc',
      moneyMakerSortKey: 'margin',
      moneyMakerSortDir: 'asc',
      moneyMakerVisibleCount: 25,
      showPipelineBacklog: false,
      showPipelinePercent: false,
      showMoneyMakerQuantity: false,
      showMoneyMakerPercent: false,
    }
    expect(sanitizeOverviewPreferences(valid)).toEqual(valid)
  })

  it('falls back per-field on a malformed blob — a bad sort key, a wrong-typed toggle, an out-of-range count, and a stray unknown key, all at once', () => {
    const malformed = {
      marginOn: 'yes', // wrong type
      pipelineSortKey: 'not_a_real_key', // invalid enum value
      moneyMakerVisibleCount: 999999, // not one of the allowed options
      showPipelineBacklog: 1, // wrong type (truthy number, not boolean)
      somethingThatNoLongerExists: { nested: 'garbage' }, // stray unknown key
    }
    expect(sanitizeOverviewPreferences(malformed)).toEqual(DEFAULT_OVERVIEW_PREFERENCES)
  })

  it('never throws on a deeply malformed blob — arrays, null-ish values, nested objects in every field', () => {
    const chaos = {
      marginOn: null,
      pipelineSortKey: ['value'],
      pipelineSortDir: 42,
      moneyMakerSortKey: {},
      moneyMakerVisibleCount: 'ten',
      showMoneyMakerQuantity: undefined,
    }
    expect(() => sanitizeOverviewPreferences(chaos)).not.toThrow()
    expect(sanitizeOverviewPreferences(chaos)).toEqual(DEFAULT_OVERVIEW_PREFERENCES)
  })
})
