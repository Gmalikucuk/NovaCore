import { describe, expect, it } from 'vitest'
import { isApplicationRateItem, isAreaUnit } from './items'

describe('isAreaUnit', () => {
  it('is true only when area_basis is quantity_is_area', () => {
    expect(isAreaUnit({ areaBasis: 'quantity_is_area' })).toBe(true)
    expect(isAreaUnit({ areaBasis: 'separately_measured' })).toBe(false)
    expect(isAreaUnit({ areaBasis: 'not_applicable' })).toBe(false)
  })

  it('is false for an unclassified Item — never inferred, never assumed', () => {
    expect(isAreaUnit({ areaBasis: null })).toBe(false)
  })
})

describe('isApplicationRateItem', () => {
  it('is true only when area_basis is separately_measured', () => {
    expect(isApplicationRateItem({ areaBasis: 'separately_measured' })).toBe(true) // e.g. Top Lift, Level Course, Shouldering
  })

  it('is false for quantity_is_area and not_applicable', () => {
    expect(isApplicationRateItem({ areaBasis: 'quantity_is_area' })).toBe(false)
    expect(isApplicationRateItem({ areaBasis: 'not_applicable' })).toBe(false) // e.g. Shoulder Aggregate (03.xx, supply — not applied, despite the near-identical name)
  })

  it('is false for an unclassified Item — never inferred, never assumed', () => {
    expect(isApplicationRateItem({ areaBasis: null })).toBe(false)
  })
})
