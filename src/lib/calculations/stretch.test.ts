import { describe, expect, it } from 'vitest'
import { areaDifference, computeAreaFromWidth, reachMetres } from './stretch'

describe('reachMetres', () => {
  it('converts a km reach to metres', () => {
    expect(reachMetres(19.385, 22.175)).toBeCloseTo(2790, 5)
  })

  it('is null when either station is missing', () => {
    expect(reachMetres(null, 22.175)).toBeNull()
    expect(reachMetres(19.385, null)).toBeNull()
    expect(reachMetres(null, null)).toBeNull()
  })
})

describe('computeAreaFromWidth', () => {
  it('multiplies width by reach — the Ministry Representative workbook example', () => {
    // 5.50 m over 2,790 m = 15,345 m²
    expect(computeAreaFromWidth(5.5, 19.385, 22.175)).toBeCloseTo(15345, 3)
  })

  it('is null when width is missing', () => {
    expect(computeAreaFromWidth(null, 19.385, 22.175)).toBeNull()
  })

  it('is null when the stretch has no reach (point work, missing stations)', () => {
    expect(computeAreaFromWidth(5.5, null, null)).toBeNull()
    expect(computeAreaFromWidth(5.5, 19.385, null)).toBeNull()
  })
})

describe('areaDifference', () => {
  it('is the signed difference when both are known', () => {
    // the brief's own July 29 milling example: entered 15,389.00 against computed 15,345
    expect(areaDifference(15389.0, 15345)).toBeCloseTo(44, 3)
  })

  it('is null when either side is unknown — never a bare 0 standing in for "nothing to compare"', () => {
    expect(areaDifference(null, 15345)).toBeNull()
    expect(areaDifference(15389, null)).toBeNull()
    expect(areaDifference(null, null)).toBeNull()
  })

  it('is exactly 0 when they agree, not a stray floating-point fraction', () => {
    expect(areaDifference(15345, 15345)).toBe(0)
    // 5.5 * 2790 computed via reachMetres/computeAreaFromWidth can carry
    // float noise — areaDifference itself is tested directly here with an
    // already-tiny delta to confirm the epsilon collapses it to a clean 0.
    expect(areaDifference(15345.001, 15345)).toBe(0)
  })

  it('is non-zero once the difference is real, however small', () => {
    expect(areaDifference(15345.5, 15345)).toBeCloseTo(0.5, 3)
  })
})
