import { describe, expect, it } from 'vitest'
import { isApplicationRateItem, isAreaUnit } from './items'

describe('isAreaUnit', () => {
  it('is true only for Square Metre', () => {
    expect(isAreaUnit('Square Metre')).toBe(true)
    expect(isAreaUnit('Tonne')).toBe(false)
    expect(isAreaUnit('Metre')).toBe(false)
    expect(isAreaUnit('Each')).toBe(false)
  })
})

describe('isApplicationRateItem', () => {
  it('is true for a Tonne Item applied over a stretch, outside the supply-stockpile section', () => {
    expect(isApplicationRateItem({ unit: 'Tonne', itemNumber: '05.03.03' })).toBe(true) // Top Lift
    expect(isApplicationRateItem({ unit: 'Tonne', itemNumber: '05.03.01' })).toBe(true) // Level Course
    expect(isApplicationRateItem({ unit: 'Tonne', itemNumber: '04.05.04' })).toBe(true) // Shouldering
  })

  it('is false for a Tonne Item in the supply-stockpile section, even with a near-identical name', () => {
    // "Shoulder Aggregate" (03.xx, supply) vs "Shouldering" (04.xx, applied) —
    // the exact pair the brief warned a keyword match would get wrong.
    expect(isApplicationRateItem({ unit: 'Tonne', itemNumber: '03.01.04' })).toBe(false) // Shoulder Aggregate
    expect(isApplicationRateItem({ unit: 'Tonne', itemNumber: '03.01.01' })).toBe(false) // Asphalt Medium Mix Aggregate
  })

  it('is false for any non-Tonne unit regardless of section', () => {
    expect(isApplicationRateItem({ unit: 'Square Metre', itemNumber: '05.03.03' })).toBe(false)
    expect(isApplicationRateItem({ unit: 'Each', itemNumber: '04.05.04' })).toBe(false)
    expect(isApplicationRateItem({ unit: 'Metre', itemNumber: '04.06.01' })).toBe(false)
    expect(isApplicationRateItem({ unit: 'Cubic Metre', itemNumber: '04.05.01' })).toBe(false)
  })
})
