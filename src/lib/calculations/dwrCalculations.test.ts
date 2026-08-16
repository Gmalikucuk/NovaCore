import { describe, expect, it } from 'vitest'
import {
  basicMarkupPct,
  computeAllBlocks,
  computeBlock,
  computeBlockF,
  lineItemsForBlock,
  subtotal,
  suggestReducedMarkups,
  summarizeSubcontractorCap,
  type DwrLineItem,
  type ForceAccountTerms,
} from './dwrCalculations'

const TERMS: ForceAccountTerms = {
  effectiveDate: '2026-01-01',
  gcVersionDate: '2026-04-01',
  labourBasicPct: 0.3,
  labourReducedPct: 0.2,
  equipmentBasicPct: 0.15,
  equipmentReducedPct: 0.1,
  materialsBasicPct: 0.15,
  materialsReducedPct: 0.15,
  prepBasicPct: 0.15,
  prepReducedPct: 0.1,
  foodBasicPct: 0.15,
  foodReducedPct: 0.15,
  subcontractorMarkupPct: 0.1,
  reducedThresholdPct: 0.25,
  subcontractorCapAmount: 100000,
}

function line(overrides: Partial<DwrLineItem>): DwrLineItem {
  return { id: 'x', block: 'A', subFlag: 'n', quantity: 1, rate: 1, amount: 1, subcontractorId: null, ...overrides }
}

describe('basicMarkupPct', () => {
  it('reads the basic figure when reduced markups do not apply', () => {
    expect(basicMarkupPct('A', TERMS, false)).toBe(0.3)
  })

  it('reads the reduced figure once the threshold is crossed', () => {
    expect(basicMarkupPct('A', TERMS, true)).toBe(0.2)
  })

  it('is per-block, not a single shared rate', () => {
    expect(basicMarkupPct('B', TERMS, false)).toBe(0.15)
    expect(basicMarkupPct('B', TERMS, true)).toBe(0.1)
  })
})

describe('lineItemsForBlock / subtotal', () => {
  it('filters to one block and sums signed amounts', () => {
    const lines = [line({ block: 'A', amount: 100 }), line({ block: 'B', amount: 50 }), line({ block: 'A', amount: -20 })]
    expect(subtotal(lineItemsForBlock(lines, 'A'))).toBe(80)
  })
})

describe('computeBlock — A-E two-tier markup', () => {
  it('applies the basic markup to the whole subtotal, no subcontractor lines', () => {
    const lines = [line({ block: 'B', subFlag: 'n', amount: 1000 })]
    const result = computeBlock('B', lines, TERMS, false, 0, 0)
    expect(result.rawSubtotal).toBe(1000)
    expect(result.basicMarkupAmount).toBe(150) // 15%
    expect(result.additionalMarkupAmount).toBe(0)
    expect(result.total).toBe(1150)
  })

  it('stacks the additional subcontractor markup only on the sub-flagged portion', () => {
    const lines = [line({ block: 'B', subFlag: 'n', amount: 1000 }), line({ block: 'B', subFlag: 'y', amount: 500 })]
    const result = computeBlock('B', lines, TERMS, false, 0, 0)
    expect(result.rawSubtotal).toBe(1500)
    expect(result.basicMarkupAmount).toBe(225) // 15% of 1500
    expect(result.additionalMarkupAmount).toBe(50) // 10% of the 500 sub-flagged portion only
    expect(result.total).toBe(1775)
  })

  it('treats sub_flag "a" the same as "n" — no additional markup', () => {
    const lines = [line({ block: 'B', subFlag: 'a', amount: 500 })]
    const result = computeBlock('B', lines, TERMS, false, 0, 0)
    expect(result.additionalMarkupAmount).toBe(0)
  })

  it('switches to the reduced basic rate when reducedMarkups is true', () => {
    const lines = [line({ block: 'A', subFlag: 'n', amount: 1000 })]
    const reduced = computeBlock('A', lines, TERMS, true, 0, 0)
    const notReduced = computeBlock('A', lines, TERMS, false, 0, 0)
    expect(reduced.basicMarkupAmount).toBe(200) // 20%
    expect(notReduced.basicMarkupAmount).toBe(300) // 30%
  })

  it('Block A folds payroll additive and tool allowance in before the basic markup', () => {
    const lines = [line({ block: 'A', subFlag: 'n', amount: 1000 })]
    const result = computeBlock('A', lines, TERMS, false, 0.35, 0.01) // 35% payroll, 1% tool
    expect(result.payrollAdditiveAmount).toBe(350)
    expect(result.toolAllowanceAmount).toBe(10)
    // basic markup applies to 1000 + 350 + 10 = 1360, at 30%
    expect(result.basicMarkupAmount).toBeCloseTo(408, 5)
    expect(result.total).toBeCloseTo(1000 + 350 + 10 + 408, 5)
  })

  it('other blocks never apply payroll/tool even if a caller passes a nonzero rate', () => {
    const lines = [line({ block: 'C', subFlag: 'n', amount: 1000 })]
    const result = computeBlock('C', lines, TERMS, false, 0, 0)
    expect(result.payrollAdditiveAmount).toBe(0)
    expect(result.toolAllowanceAmount).toBe(0)
  })
})

describe('computeBlockF — negotiated price, no cost-buildup markup', () => {
  it('is zero markup for the Contractor’s own negotiated work (sub_flag n)', () => {
    const lines = [line({ block: 'F', subFlag: 'n', amount: 50000 })]
    const result = computeBlockF(lines, TERMS)
    expect(result.rawSubtotal).toBe(50000)
    expect(result.basicMarkupAmount).toBe(0)
    expect(result.additionalMarkupAmount).toBe(0)
    expect(result.total).toBe(50000)
  })

  it('a negative amount (a credit) is not rejected — it subtracts', () => {
    const lines = [line({ block: 'F', subFlag: 'n', amount: 50000 }), line({ block: 'F', subFlag: 'n', amount: -500 })]
    const result = computeBlockF(lines, TERMS)
    expect(result.rawSubtotal).toBe(49500)
    expect(result.total).toBe(49500)
  })

  it('stacks basic + additional subcontractor markup for a subcontractor’s own negotiated price', () => {
    const lines = [line({ block: 'F', subFlag: 'y', amount: 10000 })]
    const result = computeBlockF(lines, TERMS)
    expect(result.basicMarkupAmount).toBe(1000) // 10%
    expect(result.additionalMarkupAmount).toBe(1000) // 10%, stacked
    expect(result.total).toBe(12000)
  })
})

describe('computeAllBlocks', () => {
  it('sums every block’s own total into totalPayable', () => {
    const lines = [line({ block: 'A', amount: 1000 }), line({ block: 'F', subFlag: 'n', amount: 50000 })]
    const { blocks, totalPayable } = computeAllBlocks(lines, TERMS, false, 0, 0)
    expect(blocks).toHaveLength(6)
    const blockA = blocks.find((b) => b.block === 'A')!
    const blockF = blocks.find((b) => b.block === 'F')!
    expect(totalPayable).toBeCloseTo(blockA.total + blockF.total, 5)
  })

  it('an empty DWR totals zero, not null or an error', () => {
    const { totalPayable } = computeAllBlocks([], TERMS, false, 0, 0)
    expect(totalPayable).toBe(0)
  })
})

describe('suggestReducedMarkups', () => {
  it('suggests reduced once cumulative force account reaches the threshold', () => {
    const result = suggestReducedMarkups(250000, 1000000, TERMS)
    expect(result.ratio).toBe(0.25)
    expect(result.suggestReduced).toBe(true)
  })

  it('does not suggest reduced below the threshold', () => {
    const result = suggestReducedMarkups(100000, 1000000, TERMS)
    expect(result.suggestReduced).toBe(false)
  })

  it('never suggests reduced when Tender Price is not on file — no guess', () => {
    const result = suggestReducedMarkups(999999, null, TERMS)
    expect(result.suggestReduced).toBe(false)
    expect(result.ratio).toBe(0)
  })
})

describe('summarizeSubcontractorCap', () => {
  it('buckets markup dollars per attributed subcontractor and flags over-cap', () => {
    const result = summarizeSubcontractorCap(
      [
        { subcontractorId: 'sub-1', markupAmount: 60000 },
        { subcontractorId: 'sub-1', markupAmount: 50000 },
        { subcontractorId: 'sub-2', markupAmount: 1000 },
      ],
      100000,
    )
    const sub1 = result.bySubcontractor.find((s) => s.subcontractorId === 'sub-1')!
    const sub2 = result.bySubcontractor.find((s) => s.subcontractorId === 'sub-2')!
    expect(sub1.markupToDate).toBe(110000)
    expect(sub1.overCap).toBe(true)
    expect(sub2.markupToDate).toBe(1000)
    expect(sub2.overCap).toBe(false)
  })

  it('lines with no subcontractor_id are real money, kept separate as unattributed — never silently dropped', () => {
    const result = summarizeSubcontractorCap([{ subcontractorId: null, markupAmount: 5000 }], 100000)
    expect(result.bySubcontractor).toEqual([])
    expect(result.unattributedMarkup).toBe(5000)
  })

  it('lines with zero markup contribute nothing either way', () => {
    const result = summarizeSubcontractorCap([{ subcontractorId: 'sub-1', markupAmount: 0 }], 100000)
    expect(result.bySubcontractor).toEqual([])
    expect(result.unattributedMarkup).toBe(0)
  })
})
