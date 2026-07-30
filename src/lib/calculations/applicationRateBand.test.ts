import { describe, expect, it } from 'vitest'
import { classifyApplicationRateBand } from './applicationRateBand'

const VENABLES_BANDS = { bonusBandLowPct: 96, bonusBandHighPct: 104, rejectBandLowPct: 85, rejectBandHighPct: 110 }

describe('classifyApplicationRateBand', () => {
  it('classifies inside the bonus band, including its exact edges', () => {
    expect(classifyApplicationRateBand(100, VENABLES_BANDS)).toBe('bonus')
    expect(classifyApplicationRateBand(96, VENABLES_BANDS)).toBe('bonus')
    expect(classifyApplicationRateBand(104, VENABLES_BANDS)).toBe('bonus')
  })

  it('classifies the sliding penalty region between reject and bonus, on both sides', () => {
    expect(classifyApplicationRateBand(90, VENABLES_BANDS)).toBe('penalty')
    expect(classifyApplicationRateBand(107, VENABLES_BANDS)).toBe('penalty')
  })

  it('classifies below the low reject bound and at/above the high reject bound as reject', () => {
    expect(classifyApplicationRateBand(84.9, VENABLES_BANDS)).toBe('reject')
    expect(classifyApplicationRateBand(110, VENABLES_BANDS)).toBe('reject')
    expect(classifyApplicationRateBand(150, VENABLES_BANDS)).toBe('reject')
  })

  it('returns unavailable when any band threshold is missing, rather than guessing', () => {
    expect(
      classifyApplicationRateBand(100, {
        bonusBandLowPct: null,
        bonusBandHighPct: 104,
        rejectBandLowPct: 85,
        rejectBandHighPct: 110,
      }),
    ).toBe('unavailable')
  })
})
