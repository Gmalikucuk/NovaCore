import ExcelJS from 'exceljs'

/**
 * Shared across every Excel export in this app (Tracker, Finance) — pulled
 * out once both existed, rather than a second copy of roundMoney's own
 * float-tail rationale drifting from the first.
 */

export const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } }
export const HEADER_BORDER: Partial<ExcelJS.Borders> = { bottom: { style: 'thin', color: { argb: 'FF000000' } } }
export const MONEY_FORMAT = '$#,##0.00'
export const PERCENT_FORMAT = '0.0%'

export function quantityFormat(unit: string): string {
  return unit === 'Each' ? '#,##0' : '#,##0.00'
}

/**
 * Every money figure in these exports is either a product (quantity × rate)
 * or a sum of such products — both routine sources of a float tail like
 * 10142.999999999995. MONEY_FORMAT's two-decimal display hides it on
 * screen, but the underlying cell value is what Excel actually sums,
 * compares, or exports elsewhere — round at the point of writing, not just
 * the point of display, so the stored number matches what's shown.
 */
export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

export function styleHeaderCell(cell: ExcelJS.Cell) {
  cell.font = { bold: true }
  cell.fill = HEADER_FILL
  cell.border = HEADER_BORDER
}

export function styleHeaderRow(row: ExcelJS.Row) {
  row.eachCell({ includeEmpty: true }, styleHeaderCell)
}

/**
 * A date cell at exact midnight, timezone-independent — exceljs's own
 * serial-number conversion (`dateToExcel`, utils.js) is `d.getTime() / 86400000`,
 * i.e. it reads the Date's real UTC instant, not its local calendar fields.
 * A `new Date(y, m-1, d)` LOCAL-constructor date is midnight in the
 * *browser's* zone, which for anything west of UTC lands on a non-integer
 * serial (a "7:00" bleeding into the stored value, invisible under the
 * display format but wrong for any exact date comparison, lookup, or pivot
 * grouping in Excel). Constructing via `Date.UTC` instead makes the
 * instant itself exactly midnight, so the serial has no fractional part.
 */
export function pureDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day))
}

export function triggerDownload(buffer: ArrayBuffer, filename: string) {
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
