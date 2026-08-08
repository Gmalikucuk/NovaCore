import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import type { MyContract } from '../supabase/contracts'
import type { Item } from '../supabase/items'
import type { ItemProgressRate } from '../supabase/monthlyPeriods'
import { remainingDisplay } from '../calculations/trackerRemaining'
import { buildSummarySheet, buildTrackerSheet, type LoadedData } from './trackerExport'

/**
 * buildTrackerSheet/buildSummarySheet take a pre-fetched LoadedData object
 * with no network calls inside them — hand-building the fixture here
 * exercises the exact per-item cell logic without mocking Supabase.
 *
 * The unit_price fixture reuses trackerRemaining.test.ts's own real figures
 * (Venables 04.03.01, Aug 2026: approx 1,200, to date 1,698.75, 498.75
 * over) — the same remainingDisplay() call both TrackerScreen and this
 * export make, so asserting against remainingDisplay()'s own output here
 * (sign-flipped for Excel) is what proves the two paths can't drift,
 * rather than re-deriving a second copy of the expected number.
 */

const CONTRACT: MyContract = {
  id: 'contract-1',
  name: 'Test Contract',
  contractNo: 'TC-1',
  isSandbox: false,
  tenderPrice: null,
  contractEnd: null,
  contractState: 'active',
  costTrackingEnabled: false,
  createItems: false,
  setCost: false,
  setUnitPrice: false,
  enterQuantity: false,
  correctQuantity: false,
  confirmQuantity: false,
  viewRates: true,
  extractReport: false,
}

const UNIT_PRICE_ITEM: Item = {
  id: 'item-up',
  contractId: CONTRACT.id,
  itemNumber: '04.03.01',
  description: 'Milled Tie Ins',
  unit: 'Tonne',
  approximateQuantity: 1200,
  itemKind: 'unit_price',
  provisionalSum: null,
  percentComplete: null,
  authorizedValue: null,
  areaBasis: null,
}

const UNIT_PRICE_PROGRESS: ItemProgressRate = {
  itemId: UNIT_PRICE_ITEM.id,
  contractId: CONTRACT.id,
  itemNumber: UNIT_PRICE_ITEM.itemNumber,
  description: UNIT_PRICE_ITEM.description,
  unit: UNIT_PRICE_ITEM.unit,
  itemKind: 'unit_price',
  approximateQuantity: 1200,
  quantityToDate: 1698.75,
  proportionComplete: 1698.75 / 1200,
  quantityRemaining: 0, // clamped — this row is over quantity
  quantityLast30: 0,
  workingDaysLast30: null,
  lastWorkDate: '2026-08-01',
  workingDaysRemaining: null,
  isStalled: false,
  isOverQuantity: true,
}

const LUMP_SUM_ITEM: Item = {
  id: 'item-ls',
  contractId: CONTRACT.id,
  itemNumber: '04.03.02',
  description: 'Mobilization',
  unit: 'LS',
  approximateQuantity: 1,
  itemKind: 'lump_sum',
  provisionalSum: null,
  percentComplete: 65,
  authorizedValue: null,
  areaBasis: null,
}

const PROVISIONAL_SUM_ITEM: Item = {
  id: 'item-ps',
  contractId: CONTRACT.id,
  itemNumber: '04.03.03',
  description: 'Utility Relocations Allowance',
  unit: 'LS',
  approximateQuantity: 1,
  itemKind: 'provisional_sum',
  provisionalSum: 50000,
  percentComplete: null,
  authorizedValue: 32000,
  areaBasis: null,
}

function buildFixture(): LoadedData {
  return {
    items: [UNIT_PRICE_ITEM, LUMP_SUM_ITEM, PROVISIONAL_SUM_ITEM],
    // Lump Sum/Provisional Sum are deliberately absent — v_item_progress_rate
    // carries no rows for them, same as the real view.
    progressByItem: new Map([[UNIT_PRICE_ITEM.id, UNIT_PRICE_PROGRESS]]),
    priceByItem: new Map([[UNIT_PRICE_ITEM.id, { itemId: UNIT_PRICE_ITEM.id, costPrice: null, costBasis: null, unitPrice: 45.5, updatedBy: null, updatedAt: '2026-08-01' }]]),
    itemMonthByKey: new Map(),
    allRecords: [],
    reconciliation: new Map(),
    namesById: new Map(),
    periods: [],
    periodsWithData: new Set(),
    dateRange: null,
  }
}

function findRow(sheet: ExcelJS.Worksheet, itemNumber: string): ExcelJS.Row {
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r)
    if (row.getCell(1).value === itemNumber) return row
  }
  throw new Error(`row for ${itemNumber} not found`)
}

describe('buildTrackerSheet', () => {
  it('Remaining is remainingDisplay()s own magnitude, sign-flipped for an over-quantity unit_price row', () => {
    const workbook = new ExcelJS.Workbook()
    buildTrackerSheet(workbook, CONTRACT, buildFixture())
    const sheet = workbook.getWorksheet('Tracker')!
    const row = findRow(sheet, UNIT_PRICE_ITEM.itemNumber)

    const expected = remainingDisplay(UNIT_PRICE_PROGRESS)
    expect(expected).toEqual({ isOverQuantity: true, amount: 498.75 })
    // Remaining is column 6: Item#, Description, UOM, Contract Qty, Done to Date, Remaining.
    expect(row.getCell(6).value).toBeCloseTo(-expected.amount, 6)
    expect(row.getCell(4).value).toBe(1200) // Contract Qty
    expect(row.getCell(5).value).toBeCloseTo(1698.75, 6) // Done to Date
  })

  it('Lump Sum reads %Complete from percentComplete directly, not from progressByItem (which has no row for it)', () => {
    const workbook = new ExcelJS.Workbook()
    buildTrackerSheet(workbook, CONTRACT, buildFixture())
    const sheet = workbook.getWorksheet('Tracker')!
    const row = findRow(sheet, LUMP_SUM_ITEM.itemNumber)

    expect(row.getCell(4).value).toBe('—') // Contract Qty — no quantity for Lump Sum
    expect(row.getCell(6).value).toBe('—') // Remaining — no quantity for Lump Sum
    expect(row.getCell(7).value).toBeCloseTo(0.65, 6) // %Complete = percentComplete / 100
  })

  it('Provisional Sum reads Authorized Value/Provisional Sum straight off the Item, not off progressByItem', () => {
    const workbook = new ExcelJS.Workbook()
    buildTrackerSheet(workbook, CONTRACT, buildFixture())
    const sheet = workbook.getWorksheet('Tracker')!
    const row = findRow(sheet, PROVISIONAL_SUM_ITEM.itemNumber)

    expect(row.getCell(7).value).toBe('—') // %Complete — doesn't apply
    // Trailing block starts at column 8 (no periods in this fixture): Authorized Value, Provisional Sum.
    expect(row.getCell(8).value).toBe(32000)
    expect(row.getCell(9).value).toBe(50000)
  })
})

describe('buildSummarySheet', () => {
  it('produces the identical signed Remaining and %Complete figures as the Tracker sheet for the same fixture', () => {
    const fixture = buildFixture()
    const trackerWorkbook = new ExcelJS.Workbook()
    buildTrackerSheet(trackerWorkbook, CONTRACT, fixture)
    const trackerSheet = trackerWorkbook.getWorksheet('Tracker')!

    const summaryWorkbook = new ExcelJS.Workbook()
    buildSummarySheet(summaryWorkbook, CONTRACT, fixture)
    const summarySheet = summaryWorkbook.getWorksheet('Summary')!

    for (const item of [UNIT_PRICE_ITEM, LUMP_SUM_ITEM, PROVISIONAL_SUM_ITEM]) {
      const trackerRow = findRow(trackerSheet, item.itemNumber)
      const summaryRow = findRow(summarySheet, item.itemNumber)
      // Summary sheet columns: Item#, Description, Approx. Qty, Qty to Date, Remaining, %Complete.
      expect(summaryRow.getCell(5).value).toEqual(trackerRow.getCell(6).value)
      expect(summaryRow.getCell(6).value).toEqual(trackerRow.getCell(7).value)
    }
  })
})
