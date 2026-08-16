import { describe, expect, it } from 'vitest'
import { resolveFinanceMonthColumns } from './financeMonthColumns'

describe('resolveFinanceMonthColumns', () => {
  it('a seat who has never touched the control, no cost visibility: the proposed default set', () => {
    expect(resolveFinanceMonthColumns(null, false)).toEqual({
      quantityInPeriod: true,
      valueToDate: true,
      quantityToDate: false,
      costInPeriod: false,
      marginInPeriod: false,
      costToDate: false,
      marginToDate: false,
    })
  })

  it('cost visibility alone does not turn cost columns on — they stay opt-in even for a seat who could see them', () => {
    expect(resolveFinanceMonthColumns(null, true)).toEqual({
      quantityInPeriod: true,
      valueToDate: true,
      quantityToDate: false,
      costInPeriod: false,
      marginInPeriod: false,
      costToDate: false,
      marginToDate: false,
    })
  })

  it('a saved preference turning quantityInPeriod off is respected, others keep defaulting', () => {
    expect(resolveFinanceMonthColumns({ quantityInPeriod: false }, false)).toEqual({
      quantityInPeriod: false,
      valueToDate: true,
      quantityToDate: false,
      costInPeriod: false,
      marginInPeriod: false,
      costToDate: false,
      marginToDate: false,
    })
  })

  it('a saved preference turning cost columns on is respected when this seat has cost visibility', () => {
    expect(resolveFinanceMonthColumns({ costInPeriod: true, marginToDate: true }, true)).toEqual({
      quantityInPeriod: true,
      valueToDate: true,
      quantityToDate: false,
      costInPeriod: true,
      marginInPeriod: false,
      costToDate: false,
      marginToDate: true,
    })
  })

  it('a stale saved preference cannot revive a cost column once this seat has lost cost visibility', () => {
    expect(resolveFinanceMonthColumns({ costInPeriod: true, marginInPeriod: true, costToDate: true, marginToDate: true }, false)).toEqual({
      quantityInPeriod: true,
      valueToDate: true,
      quantityToDate: false,
      costInPeriod: false,
      marginInPeriod: false,
      costToDate: false,
      marginToDate: false,
    })
  })

  it('a non-boolean value for a key is ignored, falling back to the computed default', () => {
    expect(resolveFinanceMonthColumns({ quantityInPeriod: 'yes' }, false).quantityInPeriod).toBe(true)
  })
})
