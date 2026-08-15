import { describe, expect, it } from 'vitest'
import { resolveRatesColumns } from './ratesColumns'

describe('resolveRatesColumns', () => {
  it('a seat who has never touched the control, cost tracking off: every cost column off, earned columns off', () => {
    expect(resolveRatesColumns(null, true, false)).toEqual({
      unitCost: false,
      extCost: false,
      margin: false,
      marginPercent: false,
      percentComplete: false,
      authorizedValue: false,
    })
  })

  it('a seat who has never touched the control, cost tracking on: every cost column defaults on', () => {
    expect(resolveRatesColumns(null, true, true)).toEqual({
      unitCost: true,
      extCost: true,
      margin: true,
      marginPercent: true,
      percentComplete: false,
      authorizedValue: false,
    })
  })

  it('cost tracking on, but this seat has no cost visibility: cost columns stay off regardless', () => {
    expect(resolveRatesColumns(null, false, true)).toEqual({
      unitCost: false,
      extCost: false,
      margin: false,
      marginPercent: false,
      percentComplete: false,
      authorizedValue: false,
    })
  })

  it('a saved preference explicitly turning one cost column off is respected, others keep defaulting', () => {
    expect(resolveRatesColumns({ unitCost: false }, true, true)).toEqual({
      unitCost: false,
      extCost: true,
      margin: true,
      marginPercent: true,
      percentComplete: false,
      authorizedValue: false,
    })
  })

  it('a saved preference turning a cost column on survives even though cost tracking is off, for a seat with cost visibility', () => {
    expect(resolveRatesColumns({ margin: true }, true, false)).toEqual({
      unitCost: false,
      extCost: false,
      margin: true,
      marginPercent: false,
      percentComplete: false,
      authorizedValue: false,
    })
  })

  it('a stale saved preference cannot revive a cost column once this seat has lost cost visibility — rights are not negotiable by the control', () => {
    expect(resolveRatesColumns({ unitCost: true, extCost: true, margin: true, marginPercent: true }, false, true)).toEqual({
      unitCost: false,
      extCost: false,
      margin: false,
      marginPercent: false,
      percentComplete: false,
      authorizedValue: false,
    })
  })

  it('percentComplete/authorizedValue are independent of cost tracking entirely', () => {
    expect(resolveRatesColumns({ percentComplete: true, authorizedValue: true }, false, false)).toEqual({
      unitCost: false,
      extCost: false,
      margin: false,
      marginPercent: false,
      percentComplete: true,
      authorizedValue: true,
    })
  })

  it('a non-boolean value for a key is ignored, falling back to the computed default', () => {
    expect(resolveRatesColumns({ unitCost: 'yes' }, true, true).unitCost).toBe(true)
  })
})
