import { describe, expect, it } from 'vitest'
import { findStrictlyInsideCoverage, isRangeFullyCovered, mergeIntervals } from './intervalCoverage'

describe('mergeIntervals', () => {
  it('returns nothing for an empty input', () => {
    expect(mergeIntervals([])).toEqual([])
  })

  it('leaves a single interval unchanged', () => {
    expect(mergeIntervals([{ lo: 10, hi: 20 }])).toEqual([{ lo: 10, hi: 20 }])
  })

  it('merges overlapping intervals', () => {
    expect(mergeIntervals([{ lo: 0, hi: 100 }, { lo: 50, hi: 150 }])).toEqual([{ lo: 0, hi: 150 }])
  })

  it('merges touching intervals (lo === previous hi)', () => {
    expect(mergeIntervals([{ lo: 0, hi: 100 }, { lo: 100, hi: 200 }])).toEqual([{ lo: 0, hi: 200 }])
  })

  it('does not merge intervals with a real gap', () => {
    expect(mergeIntervals([{ lo: 0, hi: 100 }, { lo: 101, hi: 200 }])).toEqual([
      { lo: 0, hi: 100 },
      { lo: 101, hi: 200 },
    ])
  })

  it('sorts unordered input before merging', () => {
    expect(
      mergeIntervals([
        { lo: 500, hi: 600 },
        { lo: 0, hi: 100 },
        { lo: 90, hi: 200 },
      ]),
    ).toEqual([
      { lo: 0, hi: 200 },
      { lo: 500, hi: 600 },
    ])
  })

  it('merges a fully-contained interval without producing a spurious extra group', () => {
    expect(mergeIntervals([{ lo: 0, hi: 500 }, { lo: 100, hi: 200 }])).toEqual([{ lo: 0, hi: 500 }])
  })

  it('merges three same-day intervals chained end to end', () => {
    expect(
      mergeIntervals([
        { lo: 0, hi: 50 },
        { lo: 50, hi: 100 },
        { lo: 100, hi: 150 },
      ]),
    ).toEqual([{ lo: 0, hi: 150 }])
  })
})

describe('findStrictlyInsideCoverage', () => {
  const merged = [{ lo: 0, hi: 100 }, { lo: 200, hi: 300 }]

  it('flags a station strictly inside a covered interval', () => {
    expect(findStrictlyInsideCoverage(50, merged)).toEqual({ lo: 0, hi: 100 })
  })

  it('allows a station exactly on the lower boundary', () => {
    expect(findStrictlyInsideCoverage(0, merged)).toBeNull()
  })

  it('allows a station exactly on the upper boundary (continuing from where coverage ends)', () => {
    expect(findStrictlyInsideCoverage(100, merged)).toBeNull()
  })

  it('allows a station in a real gap between covered intervals', () => {
    expect(findStrictlyInsideCoverage(150, merged)).toBeNull()
  })

  it('allows a station outside all covered intervals', () => {
    expect(findStrictlyInsideCoverage(1000, merged)).toBeNull()
  })

  it('returns null for an empty coverage list', () => {
    expect(findStrictlyInsideCoverage(50, [])).toBeNull()
  })
})

describe('isRangeFullyCovered', () => {
  it('is true when one merged interval spans the whole range', () => {
    expect(isRangeFullyCovered(0, 100, [{ lo: 0, hi: 100 }])).toBe(true)
  })

  it('is true when the merged interval extends past both ends', () => {
    expect(isRangeFullyCovered(20, 80, [{ lo: 0, hi: 100 }])).toBe(true)
  })

  it('is false when there is a gap inside the range', () => {
    expect(isRangeFullyCovered(0, 100, [{ lo: 0, hi: 40 }, { lo: 60, hi: 100 }])).toBe(false)
  })

  it('is false when coverage stops short of one end', () => {
    expect(isRangeFullyCovered(0, 100, [{ lo: 0, hi: 90 }])).toBe(false)
  })

  it('is false for an empty coverage list', () => {
    expect(isRangeFullyCovered(0, 100, [])).toBe(false)
  })
})
