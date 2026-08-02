import { describe, expect, it } from 'vitest'
import { concentrationByValue } from './concentration'

describe('concentrationByValue', () => {
  it('sorts descending by value', () => {
    const rows = concentrationByValue([
      { itemNo: 'a', value: 50 },
      { itemNo: 'b', value: 100 },
      { itemNo: 'c', value: 25 },
    ])
    expect(rows.map((r) => r.itemNo)).toEqual(['b', 'a', 'c'])
  })

  it('computes a running cumulative share that reaches 1 at the end', () => {
    const rows = concentrationByValue([
      { itemNo: 'a', value: 100 },
      { itemNo: 'b', value: 50 },
      { itemNo: 'c', value: 25 },
    ])
    expect(rows[0].cumulativeShare).toBeCloseTo(100 / 175, 5)
    expect(rows[1].cumulativeShare).toBeCloseTo(150 / 175, 5)
    expect(rows[2].cumulativeShare).toBeCloseTo(1, 10)
  })

  it('does not divide by zero when total value is zero', () => {
    const rows = concentrationByValue([{ itemNo: 'a', value: 0 }])
    expect(rows[0].cumulativeShare).toBe(0)
  })

  it('returns an empty array for no items', () => {
    expect(concentrationByValue([])).toEqual([])
  })
})
