import { describe, expect, it } from 'vitest'
import { compareItemCodes, sectionLabel, sectionPrefix } from './naturalSort'

describe('compareItemCodes', () => {
  it('sorts zero-padded numeric segments numerically, not lexicographically', () => {
    expect(compareItemCodes('04.09', '04.10')).toBeLessThan(0)
    expect(compareItemCodes('04.10', '04.09')).toBeGreaterThan(0)
  })

  it('sorts a deeper segment correctly', () => {
    expect(compareItemCodes('05.03.03', '05.03.04')).toBeLessThan(0)
  })

  it('handles unpadded numeric segments of different digit counts', () => {
    expect(compareItemCodes('5.3.4', '5.3.10')).toBeLessThan(0)
  })

  it('returns 0 for identical codes', () => {
    expect(compareItemCodes('05.03.03', '05.03.03')).toBe(0)
  })

  it('sorts a realistic list into the expected order', () => {
    const codes = ['05.03.04', '05.03.03', '04.10', '04.09', '03.01.01', '03.01.02']
    expect([...codes].sort(compareItemCodes)).toEqual([
      '03.01.01',
      '03.01.02',
      '04.09',
      '04.10',
      '05.03.03',
      '05.03.04',
    ])
  })

  it('falls back to string comparison for non-numeric segments', () => {
    expect(compareItemCodes('A.01', 'B.01')).toBeLessThan(0)
  })
})

describe('sectionPrefix', () => {
  it('reads the leading two-digit prefix off an item number', () => {
    expect(sectionPrefix('05.03.03')).toBe('05')
    expect(sectionPrefix('04.10')).toBe('04')
  })

  it('pads an unpadded single-digit prefix', () => {
    expect(sectionPrefix('5.03.03')).toBe('05')
  })
})

describe('sectionLabel', () => {
  it('maps a known prefix to its real Schedule 7 name', () => {
    expect(sectionLabel('01')).toBe('01 General')
    expect(sectionLabel('05')).toBe('05 Paving')
    expect(sectionLabel('06')).toBe('06 Signing')
  })

  it('falls back to a generated label for an unknown prefix', () => {
    expect(sectionLabel('99')).toBe('Section 99')
  })
})
