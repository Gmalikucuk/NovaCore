import { describe, expect, it } from 'vitest'
import {
  basicMarkupPct,
  computeAllBlocks,
  computeBlock,
  computeBlockF,
  lineItemsForBlock,
  pctToFraction,
  resolveEquipmentRate,
  resolveLabourClassRate,
  resolveMaterialRate,
  subtotal,
  suggestReducedMarkups,
  summarizeSubcontractorCap,
  yearOfWorkDate,
  type DwrLineItem,
  type ForceAccountTerms,
} from './dwrCalculations'

// Raw numbers (30 meaning 30%), not fractions — the schema-wide convention,
// fixed here after 20260816210000 caught contract_force_account_terms as
// the one table stored the other way. basicMarkupPct()/pctToFraction() etc.
// convert internally; assertions below check the resulting FRACTION they
// hand back (0.3, not 30), same as before this fixture changed.
const TERMS: ForceAccountTerms = {
  effectiveDate: '2026-01-01',
  gcVersionDate: '2026-04-01',
  labourBasicPct: 30,
  labourReducedPct: 20,
  equipmentBasicPct: 15,
  equipmentReducedPct: 10,
  materialsBasicPct: 15,
  materialsReducedPct: 15,
  prepBasicPct: 15,
  prepReducedPct: 10,
  foodBasicPct: 15,
  foodReducedPct: 15,
  subcontractorMarkupPct: 10,
  reducedThresholdPct: 25,
  subcontractorCapAmount: 100000,
}

function line(overrides: Partial<DwrLineItem>): DwrLineItem {
  return { id: 'x', block: 'A', subFlag: 'n', quantity: 1, rate: 1, amount: 1, subcontractorId: null, ...overrides }
}

describe('pctToFraction', () => {
  it('converts a raw percent number to the fraction arithmetic needs', () => {
    expect(pctToFraction(30)).toBe(0.3)
    expect(pctToFraction(0)).toBe(0)
    expect(pctToFraction(100)).toBe(1)
  })
})

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

describe('yearOfWorkDate', () => {
  it('reads the calendar year out of an ISO work date', () => {
    expect(yearOfWorkDate('2026-08-11')).toBe(2026)
  })
})

describe('resolveEquipmentRate', () => {
  const rates = [
    { equipmentId: 'eq-1', bookYear: 2024, blueBookRate: 100 },
    { equipmentId: 'eq-1', bookYear: 2026, blueBookRate: 145 },
    { equipmentId: 'eq-2', bookYear: 2026, blueBookRate: null },
  ]

  it('resolves the edition at or before the work date’s calendar year', () => {
    expect(resolveEquipmentRate('eq-1', '2026-08-11', rates)).toBe(145)
    expect(resolveEquipmentRate('eq-1', '2025-01-01', rates)).toBe(100)
  })

  it('is null when no edition exists at or before that year — absent, not zero', () => {
    expect(resolveEquipmentRate('eq-1', '2023-01-01', rates)).toBeNull()
  })

  it('is null when the machine has no rows at all', () => {
    expect(resolveEquipmentRate('eq-nonexistent', '2026-08-11', rates)).toBeNull()
  })

  it('is null when the edition on file has no blue_book_rate typed in', () => {
    expect(resolveEquipmentRate('eq-2', '2026-08-11', rates)).toBeNull()
  })

  it('never resolves a future edition', () => {
    const futureOnly = [{ equipmentId: 'eq-3', bookYear: 2030, blueBookRate: 999 }]
    expect(resolveEquipmentRate('eq-3', '2026-08-11', futureOnly)).toBeNull()
  })
})

describe('resolveLabourClassRate', () => {
  const rates = [
    { labourClassId: 'lc-1', effectiveDate: '2024-01-01', hourlyRate: 40 },
    { labourClassId: 'lc-1', effectiveDate: '2026-01-01', hourlyRate: 45.5 },
  ]

  it('resolves the rate at or before the work date', () => {
    expect(resolveLabourClassRate('lc-1', '2026-08-11', rates)).toBe(45.5)
    expect(resolveLabourClassRate('lc-1', '2025-01-01', rates)).toBe(40)
  })

  it('is null when no rate is on file at or before that date', () => {
    expect(resolveLabourClassRate('lc-1', '2023-01-01', rates)).toBeNull()
  })
})

describe('resolveMaterialRate', () => {
  const rates = [{ materialId: 'mat-1', effectiveDate: '2026-01-01', rate: 95 }]

  it('resolves the rate at or before the work date', () => {
    expect(resolveMaterialRate('mat-1', '2026-08-11', rates)).toBe(95)
  })

  it('is null when no rate is on file at or before that date', () => {
    expect(resolveMaterialRate('mat-1', '2025-01-01', rates)).toBeNull()
  })
})
