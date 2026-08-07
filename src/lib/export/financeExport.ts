import ExcelJS from 'exceljs'
import type { MyContract } from '../supabase/contracts'
import { MONEY_FORMAT, quantityFormat, roundMoney, styleHeaderRow, triggerDownload } from './exportHelpers'

/**
 * One row per Unit Price Item, in the exact shape the Finance tab's own
 * table already computed — this export is built FROM those rows, not from
 * a second, independent fetch. Every other export in this app (Tracker) is
 * self-contained and fetches its own data; this one deliberately isn't,
 * because the whole point of this surface is that a number on screen and
 * the number in the workbook must be the same number, not two independent
 * derivations of what should be the same thing. Lump Sum/Provisional Sum
 * Items are excluded upstream (the Finance table itself is Unit-Price-only,
 * same reasoning as isUnitPriceItem everywhere else).
 */
export interface FinanceExportRow {
  itemId: string
  itemNumber: string
  description: string
  unit: string
  quantityInPeriod: number | null
  valueInPeriod: number | null
  costInPeriod: number | null
  marginInPeriod: number | null
  previousValueInPeriod: number | null
  previousMarginInPeriod: number | null
  quantityToDate: number
  valueToDate: number | null
  costToDate: number | null
  marginToDate: number | null
  approximateQuantity: number
  remaining: number
  isOverQuantity: boolean
}

export interface FinanceExportTotals {
  value: number | null
  cost: number | null
  margin: number | null
  previousValue: number | null
  previousMargin: number | null
  toDateValue: number | null
  toDateCost: number | null
  toDateMargin: number | null
}

export interface FinanceExportInput {
  contract: MyContract
  /** "August 2026" */
  periodLabel: string
  /** "July 2026" */
  previousPeriodLabel: string
  /** ISO confirmed_at of the most recently confirmed record, or null if nothing confirmed yet — the freshness note, not a page-load timestamp. */
  lastConfirmedAt: string | null
  /** "YYYY-MM-01" — the selected period, for the Item #'s deep-link hyperlink back into Daily Entry. */
  selectedPeriod: string
  rows: readonly FinanceExportRow[]
  totals: FinanceExportTotals
  /** window.location.origin — hyperlinks need an absolute URL; exceljs has no notion of "this app's own base path". */
  appOrigin: string
}

/** Builds the workbook without writing it anywhere — same separation as trackerExport, so it can be exercised without triggering a download. */
export function buildFinanceWorkbook(input: FinanceExportInput): ExcelJS.Workbook {
  const { contract, periodLabel, previousPeriodLabel, lastConfirmedAt, selectedPeriod, rows, totals, appOrigin } = input

  // The sandbox row (if any) shifts everything below it down by one — the
  // export is more dangerous than the screen here (it gets forwarded and
  // opened out of context, with no banner present to correct the
  // impression), so a sandbox contract's workbook is genuinely different
  // shape, not the same layout with a flag quietly ignored.
  const sandboxRowCount = contract.isSandbox ? 1 : 0
  const freshnessRowNum = 2 + sandboxRowCount
  const captionRowNum = 3 + sandboxRowCount
  // The cost caption only means anything once cost tracking is
  // deliberately on for this contract (0042) — every cost/margin cell
  // below is already null otherwise (monthRows nulled them upstream), so
  // there's nothing left to caveat.
  const costCaptionRowCount = contract.costTrackingEnabled ? 1 : 0
  const costCaptionRowNum = 4 + sandboxRowCount
  const headerRowNum = costCaptionRowNum + costCaptionRowCount
  const dataStartRow = headerRowNum + 1

  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Finance', { views: [{ state: 'frozen', xSplit: 2, ySplit: headerRowNum }] })

  const headers = [
    'Item #',
    'Description',
    `Quantity — ${periodLabel}`,
    `Value — ${periodLabel}`,
    `Est. Cost — ${periodLabel}`,
    `Est. Margin — ${periodLabel}`,
    `Value — ${previousPeriodLabel}`,
    `Est. Margin — ${previousPeriodLabel}`,
    'Quantity to date',
    'Value to date',
    'Est. Cost to date',
    'Est. Margin to date',
    'Approximate Quantity',
    'Remaining',
  ]
  const colCount = headers.length

  // Row 1 — title, same idiom as the Tracker export: company + contract,
  // no invented company field beyond what the contract record actually has.
  sheet.mergeCells(1, 1, 1, colCount)
  const titleCell = sheet.getCell(1, 1)
  titleCell.value = ['KEYWEST ASPHALT', contract.contractNo ?? '', contract.name].filter(Boolean).join('  |  ')
  titleCell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } }

  // Row 2 (sandbox contracts only) — the same wording as SandboxBanner,
  // unmissable, real contracts get no such line. A workbook forwarded and
  // opened out of context has no on-screen banner to correct the
  // impression, so this can't be a subtler warning than the app's own.
  if (contract.isSandbox) {
    sheet.mergeCells(2, 1, 2, colCount)
    const sandboxCell = sheet.getCell(2, 1)
    sandboxCell.value = `This is a sandbox contract for exercising every screen state — ${contract.name} is not a real contract, and its Unit Prices are invented, not tendered figures.`
    sandboxCell.font = { bold: true, color: { argb: 'FFB91C1C' } }
    sandboxCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } }
  }

  // Freshness note. Not a page-load timestamp: this is when the underlying
  // quantity_records were actually last confirmed, the same figure the
  // on-screen indicator shows, so a defensive question about the export
  // gets the identical answer as the live screen.
  sheet.mergeCells(freshnessRowNum, 1, freshnessRowNum, colCount)
  const freshnessCell = sheet.getCell(freshnessRowNum, 1)
  freshnessCell.value = lastConfirmedAt ? `Confirmed records as of ${new Date(lastConfirmedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'No confirmed records yet'
  freshnessCell.font = { italic: true }

  // The GC 52.01/52.04 caveat, same wording as the on-screen page.
  sheet.mergeCells(captionRowNum, 1, captionRowNum, colCount)
  const captionCell = sheet.getCell(captionRowNum, 1)
  captionCell.value = 'Value of Work is recorded quantity × tendered Unit Price — the Contractor’s own measure, not a Ministry-approved progress estimate.'
  captionCell.font = { italic: true, size: 9 }

  // Every "Cost"/"Margin" column below is Keywest's own bid estimate, not a
  // measured fact — NovaCore has never recorded what work actually cost.
  // Same wording as the equivalent note on Rates; a workbook forwarded out
  // of context has no screen nearby to supply this caveat on its own.
  if (contract.costTrackingEnabled) {
    sheet.mergeCells(costCaptionRowNum, 1, costCaptionRowNum, colCount)
    const costCaptionCell = sheet.getCell(costCaptionRowNum, 1)
    costCaptionCell.value = 'Cost and margin figures are Keywest’s own bid estimate — actual cost is not yet recorded in NovaCore.'
    costCaptionCell.font = { italic: true, size: 9 }
  }

  // Column headers.
  const headerRow = sheet.getRow(headerRowNum)
  headers.forEach((h, i) => (headerRow.getCell(i + 1).value = h))
  styleHeaderRow(headerRow)

  sheet.getColumn(1).width = 10
  sheet.getColumn(2).width = 42
  for (let c = 3; c <= colCount; c++) sheet.getColumn(c).width = 16

  rows.forEach((r, i) => {
    const row = sheet.getRow(dataStartRow + i)
    const qtyFmt = quantityFormat(r.unit)
    let c = 1

    // Item # links straight back to the confirmed records behind THIS
    // period's figures — the same ?itemId=&period= deep link the Tracker
    // screen already uses to reach Daily Entry, not a new drill-down path.
    row.getCell(c++).value = { text: r.itemNumber, hyperlink: `${appOrigin}/daily-entry?itemId=${r.itemId}&period=${selectedPeriod}` }
    row.getCell(c++).value = r.description

    const qtyCell = row.getCell(c++)
    qtyCell.value = r.quantityInPeriod ?? '—'
    if (r.quantityInPeriod !== null) qtyCell.numFmt = qtyFmt

    const valueCell = row.getCell(c++)
    valueCell.value = r.valueInPeriod !== null ? roundMoney(r.valueInPeriod) : '—'
    if (r.valueInPeriod !== null) valueCell.numFmt = MONEY_FORMAT

    const costCell = row.getCell(c++)
    costCell.value = r.costInPeriod !== null ? roundMoney(r.costInPeriod) : '—'
    if (r.costInPeriod !== null) costCell.numFmt = MONEY_FORMAT

    const marginCell = row.getCell(c++)
    marginCell.value = r.marginInPeriod !== null ? roundMoney(r.marginInPeriod) : '—'
    if (r.marginInPeriod !== null) marginCell.numFmt = MONEY_FORMAT

    const prevValueCell = row.getCell(c++)
    prevValueCell.value = r.previousValueInPeriod !== null ? roundMoney(r.previousValueInPeriod) : '—'
    if (r.previousValueInPeriod !== null) prevValueCell.numFmt = MONEY_FORMAT

    const prevMarginCell = row.getCell(c++)
    prevMarginCell.value = r.previousMarginInPeriod !== null ? roundMoney(r.previousMarginInPeriod) : '—'
    if (r.previousMarginInPeriod !== null) prevMarginCell.numFmt = MONEY_FORMAT

    const toDateQtyCell = row.getCell(c++)
    toDateQtyCell.value = r.quantityToDate
    toDateQtyCell.numFmt = qtyFmt

    const toDateValueCell = row.getCell(c++)
    toDateValueCell.value = r.valueToDate !== null ? roundMoney(r.valueToDate) : '—'
    if (r.valueToDate !== null) toDateValueCell.numFmt = MONEY_FORMAT

    const toDateCostCell = row.getCell(c++)
    toDateCostCell.value = r.costToDate !== null ? roundMoney(r.costToDate) : '—'
    if (r.costToDate !== null) toDateCostCell.numFmt = MONEY_FORMAT

    const toDateMarginCell = row.getCell(c++)
    toDateMarginCell.value = r.marginToDate !== null ? roundMoney(r.marginToDate) : '—'
    if (r.marginToDate !== null) toDateMarginCell.numFmt = MONEY_FORMAT

    const approxCell = row.getCell(c++)
    approxCell.value = r.approximateQuantity
    approxCell.numFmt = qtyFmt

    // Over quantity: on screen this carries the violet tone plus an icon
    // and "N over" text, deliberately not colour alone — a bare negative
    // number in a spreadsheet is easy to miss entirely, or to misread as a
    // sign error rather than a real over-quantity condition. Wording is the
    // signal that survives regardless of whether a fill renders in whatever
    // opens this file; the fill is reinforcement, not the only carrier.
    const remainingCell = row.getCell(c++)
    if (r.isOverQuantity) {
      const overAmount = Math.abs(r.remaining).toLocaleString('en-CA', { maximumFractionDigits: 2 })
      remainingCell.value = `${overAmount} over`
      remainingCell.font = { bold: true, color: { argb: 'FF5B21B6' } }
      remainingCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9FE' } }
    } else {
      remainingCell.value = r.remaining
      remainingCell.numFmt = qtyFmt
    }
  })

  // Totals row — quantity columns aren't summed (mixed units across
  // Items), same rule as the on-screen footer.
  const totalsRowNum = dataStartRow + rows.length
  const totalsRow = sheet.getRow(totalsRowNum)
  totalsRow.getCell(1).value = 'Totals'
  totalsRow.getCell(2).value = `Quantity columns aren't summed (mixed units); the $ columns are.`
  const setTotal = (col: number, value: number | null) => {
    const cell = totalsRow.getCell(col)
    cell.value = value !== null ? roundMoney(value) : '—'
    if (value !== null) cell.numFmt = MONEY_FORMAT
  }
  setTotal(4, totals.value)
  setTotal(5, totals.cost)
  setTotal(6, totals.margin)
  setTotal(7, totals.previousValue)
  setTotal(8, totals.previousMargin)
  setTotal(10, totals.toDateValue)
  setTotal(11, totals.toDateCost)
  setTotal(12, totals.toDateMargin)
  for (let c = 1; c <= colCount; c++) {
    const cell = totalsRow.getCell(c)
    cell.font = { ...(cell.font ?? {}), bold: true }
    cell.border = { top: { style: 'thin', color: { argb: 'FF000000' } } }
  }

  return workbook
}

export async function exportFinanceWorkbook(input: FinanceExportInput): Promise<void> {
  const workbook = buildFinanceWorkbook(input)
  const buffer = await workbook.xlsx.writeBuffer()
  const filename = `${input.contract.contractNo ?? input.contract.name}_Finance_${new Date().toISOString().slice(0, 10)}.xlsx`
  triggerDownload(buffer as ArrayBuffer, filename)
}
