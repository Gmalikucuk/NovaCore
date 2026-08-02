import { describe, expect, it } from 'vitest'
import { sensitivityExposure } from './sensitivity'

describe('sensitivityExposure', () => {
  it('computes drift exposure as quantity * driftPerUnit', () => {
    const [row] = sensitivityExposure([{ itemNo: 'a', quantity: 1000, costPrice: 20, contractMargin: 5000 }], 1, 0)
    expect(row.driftExposure).toBe(1000)
  })

  it('computes overrun exposure as quantity * overrunFraction * costPrice — cost only, no revenue', () => {
    const [row] = sensitivityExposure([{ itemNo: 'a', quantity: 1000, costPrice: 20, contractMargin: 5000 }], 0, 0.02)
    expect(row.overrunExposure).toBe(1000 * 0.02 * 20)
  })

  it('combines both exposures', () => {
    const [row] = sensitivityExposure([{ itemNo: 'a', quantity: 1000, costPrice: 20, contractMargin: 5000 }], 1, 0.02)
    expect(row.combinedExposure).toBe(row.driftExposure + row.overrunExposure)
  })

  it('flags when combined exposure exceeds the item contract margin', () => {
    const [row] = sensitivityExposure([{ itemNo: 'a', quantity: 1000, costPrice: 20, contractMargin: 500 }], 1, 0)
    expect(row.driftExposure).toBe(1000)
    expect(row.exceedsMargin).toBe(true)
  })

  it('does not flag when combined exposure stays under the item contract margin', () => {
    const [row] = sensitivityExposure([{ itemNo: 'a', quantity: 100, costPrice: 20, contractMargin: 5000 }], 1, 0)
    expect(row.exceedsMargin).toBe(false)
  })

  it('handles an empty item list', () => {
    expect(sensitivityExposure([], 1, 0.02)).toEqual([])
  })
})
