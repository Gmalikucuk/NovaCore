import ExcelJS from 'exceljs'
import { supabase } from '../supabase/client'
import type { MyContract } from '../supabase/contracts'
import { fetchItems, type Item } from '../supabase/items'
import { fetchItemPrices } from '../supabase/prices'
import { fetchItemMonths, fetchItemProgress } from '../supabase/monthlyPeriods'
import { fetchContractQuantityRecords } from '../supabase/quantityRecords'
import { fetchProgressEstimateReconciliation, type ProgressEstimateReconciliation } from '../supabase/progressEstimates'
import { isEffective } from '../calculations/effectiveEntries'
import { compareItemCodes, sectionLabel, sectionPrefix } from '../calculations/naturalSort'
import { margin as computeMargin } from '../calculations/margin'
import { station } from '../format'

// ─────────────────────────────────────────────────────────────────────────
// Formatting constants — matching HWY5_Daily_Tracker.xlsx, the workbook
// this export is meant to be recognisable next to, not just a database
// dump with the right numbers in it.
// ─────────────────────────────────────────────────────────────────────────

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } }
const SECTION_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } }
const HEADER_BORDER: Partial<ExcelJS.Borders> = { bottom: { style: 'thin', color: { argb: 'FF000000' } } }
const DATE_FORMAT = 'd-mmm-yyyy'
const MONTH_FORMAT = 'mmmm yyyy'
const MONEY_FORMAT = '$#,##0.00'
const PERCENT_FORMAT = '0.0%'

function quantityFormat(unit: string): string {
  return unit === 'Each' ? '#,##0' : '#,##0.00'
}

/**
 * Every money figure here is either a product (quantity × rate) or a sum of
 * such products — both routine sources of a float tail like
 * 10142.999999999995. MONEY_FORMAT's two-decimal display hides it on
 * screen, but the underlying cell value is what Excel actually sums,
 * compares, or exports elsewhere — round at the point of writing, not just
 * the point of display, so the stored number matches what's shown.
 */
function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

function styleHeaderCell(cell: ExcelJS.Cell) {
  cell.font = { bold: true }
  cell.fill = HEADER_FILL
  cell.border = HEADER_BORDER
}

function styleHeaderRow(row: ExcelJS.Row) {
  row.eachCell({ includeEmpty: true }, styleHeaderCell)
}

function styleSectionRow(row: ExcelJS.Row, colCount: number) {
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c)
    cell.font = { bold: true }
    cell.fill = SECTION_FILL
  }
}

/** "1 Aug 2026" — the title row's own date style, distinct from the column headers' "1-Aug-2026" (the reference workbook uses both forms in the same title string, e.g. "1 Aug – 10 Oct 2026"). */
function shortDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString('en-CA', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Every period from `start` to `end` inclusive, both "YYYY-MM-01" — the continuous month range the brief asks for, not just the months that happen to have records, "so the season reads continuously." */
function monthRange(start: string, end: string): string[] {
  const [sy, sm] = start.split('-').map(Number)
  const [ey, em] = end.split('-').map(Number)
  const periods: string[] = []
  let y = sy
  let m = sm
  while (y < ey || (y === ey && m <= em)) {
    periods.push(`${y}-${String(m).padStart(2, '0')}-01`)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return periods
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
function pureDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day))
}

function periodDate(period: string): Date {
  const [y, m] = period.split('-').map(Number)
  return pureDate(y, m, 1)
}

async function fetchProfileNames(ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map()
  const { data, error } = await supabase.from('profiles').select('id, full_name').in('id', ids)
  if (error) throw error
  return new Map((data ?? []).map((p) => [p.id as string, p.full_name as string | null]))
}

function triggerDownload(buffer: ArrayBuffer, filename: string) {
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

interface LoadedData {
  items: Item[]
  progressByItem: Map<string, Awaited<ReturnType<typeof fetchItemProgress>>[number]>
  priceByItem: Map<string, Awaited<ReturnType<typeof fetchItemPrices>>[number]>
  itemMonthByKey: Map<string, Awaited<ReturnType<typeof fetchItemMonths>>[number]>
  allRecords: Awaited<ReturnType<typeof fetchContractQuantityRecords>>
  reconciliation: Map<string, ProgressEstimateReconciliation>
  namesById: Map<string, string | null>
  periods: string[]
  /** Periods with at least one itemMonth row, contract-wide — distinguishes a genuinely empty ongoing month (render "—") from a past month where this one item just didn't work (render 0), same rule as the Tracker screen's own fix. */
  periodsWithData: Set<string>
  dateRange: { min: string; max: string } | null
}

async function loadData(contract: MyContract): Promise<LoadedData> {
  const [items, progress, prices, itemMonths, allRecords, reconciliation] = await Promise.all([
    fetchItems(contract.id),
    fetchItemProgress(contract.id),
    contract.viewRates ? fetchItemPrices(contract.id) : Promise.resolve([]),
    fetchItemMonths(contract.id),
    // Same scale caveat as the Tracker screen's own use of this fetch (see
    // TrackerScreen.tsx) — fine at a demo contract's scale, needs a
    // server-side aggregate before a real contract's second season.
    fetchContractQuantityRecords(contract.id),
    contract.viewRates ? fetchProgressEstimateReconciliation(contract.id) : Promise.resolve(new Map<string, ProgressEstimateReconciliation>()),
  ])

  const userIds = new Set<string>()
  for (const r of allRecords) {
    userIds.add(r.createdBy)
    if (r.confirmedBy) userIds.add(r.confirmedBy)
  }
  const namesById = await fetchProfileNames([...userIds])

  const progressByItem = new Map(progress.map((p) => [p.itemId, p]))
  const priceByItem = new Map(prices.map((p) => [p.itemId, p]))
  const itemMonthByKey = new Map(itemMonths.map((m) => [`${m.itemId}|${m.periodMonth}`, m]))

  const workDates = allRecords.map((r) => r.workDate).sort()
  const dateRange = workDates.length > 0 ? { min: workDates[0], max: workDates[workDates.length - 1] } : null

  const now = new Date()
  const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  const earliestPeriod = itemMonths.length > 0 ? [...itemMonths.map((m) => m.periodMonth)].sort()[0] : currentPeriod
  const periods = monthRange(earliestPeriod, currentPeriod)
  const periodsWithData = new Set(itemMonths.map((m) => m.periodMonth))

  return { items, progressByItem, priceByItem, itemMonthByKey, allRecords, reconciliation, namesById, periods, periodsWithData, dateRange }
}

function sortedItemsBySection(items: Item[]) {
  const byPrefix = new Map<string, Item[]>()
  for (const item of items) {
    const prefix = sectionPrefix(item.itemNumber)
    const list = byPrefix.get(prefix) ?? []
    list.push(item)
    byPrefix.set(prefix, list)
  }
  return [...byPrefix.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([prefix, sectionItems]) => ({
      prefix,
      // "SECTION 1 – GENERAL" — the reference workbook's own row-heading
      // style: the section number without its leading zero, an en dash,
      // the name upper-cased. sectionLabel() already has "01 General";
      // stripping its own leading "NN " avoids a second hardcoded name map.
      label: `SECTION ${Number(prefix)} – ${sectionLabel(prefix).replace(/^\d+\s*/, '').toUpperCase()}`,
      items: [...sectionItems].sort((a, b) => compareItemCodes(a.itemNumber, b.itemNumber)),
    }))
}

function buildTrackerSheet(workbook: ExcelJS.Workbook, contract: MyContract, data: LoadedData) {
  // Freeze extends through row 3 now — title, month-group header, and the
  // Qty/Value sub-header beneath it all stay put on scroll, same idea as
  // freezing at C3 before, just one row deeper for the added header row.
  const sheet = workbook.addWorksheet('Tracker', { views: [{ state: 'frozen', xSplit: 2, ySplit: 3 }] })
  const { items, progressByItem, priceByItem, itemMonthByKey, reconciliation, periods, periodsWithData, dateRange } = data
  const sections = sortedItemsBySection(items)

  // Summary-before-detail: the progress picture first (what you see on
  // open), the monthly detail immediately after (what you scroll into),
  // the less-frequently-needed money/MoT figures trailing at the end —
  // matching the reference workbook's own ordering, not a database dump's.
  const baseHeaders = ['Item #', 'Description', 'UOM', 'Contract Qty', 'Done to Date', 'Remaining', '% Complete']
  const trailingHeaders = contract.viewRates ? ['Authorized Value', 'Provisional Sum', 'Value to Date', 'Cost to Date', 'Margin', 'MoT Qty', 'MoT Total'] : []
  const monthHeaderCount = periods.length * (contract.viewRates ? 2 : 1)
  const colCount = baseHeaders.length + monthHeaderCount + trailingHeaders.length
  const periodStartCol = baseHeaders.length + 1
  const trailingStartCol = periodStartCol + monthHeaderCount

  // Row 1 — title, merged across the sheet. Company name isn't in the
  // schema (this is a single-tenant app built for Keywest specifically,
  // same fact this repo's own docs state elsewhere) — everything else
  // comes straight from the contract record; the date range is omitted
  // entirely rather than invented when there are no records yet to derive
  // it from.
  const titleParts = ['KEYWEST ASPHALT', contract.contractNo ?? '', contract.name]
  if (dateRange) titleParts.push(`${shortDate(dateRange.min)} – ${shortDate(dateRange.max)}`)
  sheet.mergeCells(1, 1, 1, colCount)
  const titleCell = sheet.getCell(1, 1)
  titleCell.value = titleParts.filter(Boolean).join('  |  ')
  titleCell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } }

  // Rows 2–3 — two-row header for the grouped month columns: row 2 carries
  // a cell merged across each month's Qty/Value pair reading e.g. "May
  // 2026" (a real date, formatted to hide the day, not a string — sorting
  // and filtering on it still works); row 3 carries "Qty"/"Value" beneath
  // it. Standard treatment for grouped columns — the only arrangement in
  // which a paired column reads, since otherwise the second column of the
  // pair has nothing tying it to its month. Non-grouped columns (the base
  // and trailing blocks) merge vertically across both rows instead, so
  // their header reads once, at normal height, same as every other column.
  const headerRow2 = sheet.getRow(2)
  const headerRow3 = sheet.getRow(3)
  for (let i = 0; i < baseHeaders.length; i++) {
    const c = i + 1
    sheet.mergeCells(2, c, 3, c)
    headerRow2.getCell(c).value = baseHeaders[i]
  }
  let col = periodStartCol
  for (const period of periods) {
    const monthSpan = contract.viewRates ? 2 : 1
    sheet.mergeCells(2, col, 2, col + monthSpan - 1)
    const monthCell = headerRow2.getCell(col)
    monthCell.value = periodDate(period)
    monthCell.numFmt = MONTH_FORMAT
    headerRow3.getCell(col).value = 'Qty'
    if (contract.viewRates) headerRow3.getCell(col + 1).value = 'Value'
    col += monthSpan
  }
  for (let i = 0; i < trailingHeaders.length; i++) {
    const c = trailingStartCol + i
    sheet.mergeCells(2, c, 3, c)
    headerRow2.getCell(c).value = trailingHeaders[i]
  }
  for (let c = 1; c <= colCount; c++) {
    styleHeaderCell(headerRow2.getCell(c))
    styleHeaderCell(headerRow3.getCell(c))
  }

  // Column widths — Description wide enough that a real item description
  // doesn't clip (52 chars, matching the reference workbook exactly);
  // Item #/UOM narrow, the rest sized to their content.
  sheet.getColumn(1).width = 10
  sheet.getColumn(2).width = 52
  sheet.getColumn(3).width = 10
  sheet.getColumn(4).width = 14
  sheet.getColumn(5).width = 14
  sheet.getColumn(6).width = 12
  sheet.getColumn(7).width = 12
  for (let c = periodStartCol; c < trailingStartCol; c++) sheet.getColumn(c).width = 12
  for (let c = trailingStartCol; c <= colCount; c++) sheet.getColumn(c).width = 14

  let rowNum = 4
  for (const section of sections) {
    const sectionRow = sheet.getRow(rowNum++)
    sectionRow.getCell(1).value = section.prefix
    sectionRow.getCell(2).value = section.label
    styleSectionRow(sectionRow, colCount)

    for (const item of section.items) {
      const unitPriced = item.itemKind === 'unit_price'
      const isProvisionalSum = item.itemKind === 'provisional_sum'
      const itemProgress = progressByItem.get(item.id)
      const price = priceByItem.get(item.id)
      const unitPrice = unitPriced ? (price?.unitPrice ?? null) : null
      const cost = unitPriced ? (price?.costPrice ?? null) : null
      const quantityToDate = unitPriced ? (itemProgress?.quantityToDate ?? 0) : null
      const valueToDate = unitPriced && unitPrice !== null && quantityToDate !== null ? quantityToDate * unitPrice : null
      const costToDate = unitPriced && cost !== null && quantityToDate !== null ? quantityToDate * cost : null
      const marginToDate = unitPriced ? computeMargin(quantityToDate ?? 0, cost, unitPrice) : null
      const remaining = unitPriced ? item.approximateQuantity - (quantityToDate ?? 0) : null
      const recon = reconciliation.get(item.itemNumber)
      const qtyFmt = quantityFormat(item.unit)

      const row = sheet.getRow(rowNum++)
      let c = 1
      row.getCell(c++).value = item.itemNumber
      row.getCell(c++).value = item.description
      row.getCell(c++).value = item.unit
      const contractQtyCell = row.getCell(c++)
      contractQtyCell.value = unitPriced ? item.approximateQuantity : '—'
      if (unitPriced) contractQtyCell.numFmt = qtyFmt

      // Lump Sum/Provisional Sum: "—" here, same as every other quantity
      // column — never a text label. % Complete already carries a Lump
      // Sum's figure correctly (proportion_complete is percent_complete/100
      // straight from v_item_progress); a Provisional Sum's authorized-
      // value-against-provisional-sum gets its own two numeric columns
      // below (in the trailing block) instead of being concatenated into a
      // string that Excel can't sum, sort, or thousands-separate.
      const doneCell = row.getCell(c++)
      doneCell.value = quantityToDate ?? '—'
      if (quantityToDate !== null) doneCell.numFmt = qtyFmt

      const remainingCell = row.getCell(c++)
      remainingCell.value = remaining ?? '—'
      if (remaining !== null) remainingCell.numFmt = qtyFmt

      const percentCell = row.getCell(c++)
      if (isProvisionalSum) {
        percentCell.value = '—'
      } else {
        percentCell.value = itemProgress?.proportionComplete ?? 0
        percentCell.numFmt = PERCENT_FORMAT
      }

      for (const period of periods) {
        const inPeriod = itemMonthByKey.get(`${item.id}|${period}`)
        // A period with literally nothing recorded contract-wide (the
        // ongoing current month, most likely) renders "—" rather than 0 —
        // 0 reads as "confirmed no work happened," when the true state is
        // "too early to tell." A period that HAS other activity but not
        // for this specific item still renders 0 — that 0 is a real,
        // elapsed fact, not a too-early artifact.
        const periodIsEmpty = !periodsWithData.has(period)
        const quantityInPeriod = unitPriced && !periodIsEmpty ? (inPeriod?.quantityInPeriod ?? 0) : null
        const valueInPeriod = unitPriced && unitPrice !== null && quantityInPeriod !== null ? quantityInPeriod * unitPrice : null

        const qtyCell = row.getCell(c++)
        qtyCell.value = quantityInPeriod ?? '—'
        if (quantityInPeriod !== null) qtyCell.numFmt = qtyFmt
        if (contract.viewRates) {
          const valCell = row.getCell(c++)
          valCell.value = valueInPeriod !== null ? roundMoney(valueInPeriod) : '—'
          if (valueInPeriod !== null) valCell.numFmt = MONEY_FORMAT
        }
      }

      if (contract.viewRates) {
        const authorizedCell = row.getCell(c++)
        authorizedCell.value = isProvisionalSum ? roundMoney(itemProgress?.authorizedValue ?? 0) : '—'
        if (isProvisionalSum) authorizedCell.numFmt = MONEY_FORMAT
        const provisionalCell = row.getCell(c++)
        provisionalCell.value = isProvisionalSum ? roundMoney(itemProgress?.provisionalSum ?? 0) : '—'
        if (isProvisionalSum) provisionalCell.numFmt = MONEY_FORMAT
        const valueCell = row.getCell(c++)
        valueCell.value = valueToDate !== null ? roundMoney(valueToDate) : '—'
        if (valueToDate !== null) valueCell.numFmt = MONEY_FORMAT
        const costCell = row.getCell(c++)
        costCell.value = costToDate !== null ? roundMoney(costToDate) : '—'
        if (costToDate !== null) costCell.numFmt = MONEY_FORMAT
        const marginCell = row.getCell(c++)
        marginCell.value = marginToDate !== null ? roundMoney(marginToDate) : '—'
        if (marginToDate !== null) marginCell.numFmt = MONEY_FORMAT
        const motQtyCell = row.getCell(c++)
        motQtyCell.value = recon?.certifiedQuantityToDate ?? '—'
        if (recon?.certifiedQuantityToDate != null) motQtyCell.numFmt = qtyFmt
        const motTotalCell = row.getCell(c++)
        motTotalCell.value = recon?.certifiedValueToDate != null ? roundMoney(recon.certifiedValueToDate) : '—'
        if (recon?.certifiedValueToDate != null) motTotalCell.numFmt = MONEY_FORMAT
      }
    }
  }
}

function buildRecordsSheet(workbook: ExcelJS.Workbook, data: LoadedData) {
  const sheet = workbook.addWorksheet('Records', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] })
  const { allRecords, items, namesById } = data
  const itemById = new Map(items.map((i) => [i.id, i]))
  const effectiveIds = new Set(allRecords.filter((r) => isEffective(r, allRecords)).map((r) => r.id))

  const headers = ['Work Date', 'Item #', 'Description', 'Location', 'Station From', 'Station To', 'Quantity', 'Unit', 'Status', 'Counts', 'Correction', 'Note', 'Entered By', 'Confirmed By']
  const headerRow = sheet.getRow(1)
  headers.forEach((h, i) => (headerRow.getCell(i + 1).value = h))
  styleHeaderRow(headerRow)

  const widths = [13, 10, 40, 20, 14, 14, 12, 10, 11, 8, 10, 30, 16, 16]
  widths.forEach((w, i) => (sheet.getColumn(i + 1).width = w))

  const sorted = [...allRecords].sort((a, b) => a.workDate.localeCompare(b.workDate))
  sorted.forEach((r, i) => {
    const item = itemById.get(r.itemId)
    const row = sheet.getRow(i + 2)
    const [y, m, d] = r.workDate.split('-').map(Number)
    const dateCell = row.getCell(1)
    dateCell.value = pureDate(y, m, d)
    dateCell.numFmt = DATE_FORMAT
    row.getCell(2).value = item?.itemNumber ?? r.itemId
    row.getCell(3).value = item?.description ?? ''
    row.getCell(4).value = r.location ?? ''
    row.getCell(5).value = r.stationFrom === null ? '' : station(r.stationFrom)
    row.getCell(6).value = r.stationTo === null ? '' : station(r.stationTo)
    const qtyCell = row.getCell(7)
    qtyCell.value = r.quantity
    qtyCell.numFmt = quantityFormat(item?.unit ?? '')
    row.getCell(8).value = item?.unit ?? ''
    row.getCell(9).value = r.status
    row.getCell(10).value = effectiveIds.has(r.id) ? 'Yes' : 'No'
    row.getCell(11).value = r.supersedes !== null ? 'Yes' : 'No'
    row.getCell(12).value = r.note ?? ''
    row.getCell(13).value = namesById.get(r.createdBy) ?? ''
    row.getCell(14).value = r.confirmedBy ? (namesById.get(r.confirmedBy) ?? '') : ''
  })
}

function buildSummarySheet(workbook: ExcelJS.Workbook, contract: MyContract, data: LoadedData) {
  const sheet = workbook.addWorksheet('Summary', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] })
  const { items, progressByItem, priceByItem } = data
  const sortedItems = [...items].sort((a, b) => compareItemCodes(a.itemNumber, b.itemNumber))

  const headers = ['Item #', 'Description', 'Approx. Qty', 'Qty to Date', 'Remaining', '% Complete', ...(contract.viewRates ? ['Unit Price', 'Value to Date', 'Cost to Date', 'Margin'] : [])]
  const headerRow = sheet.getRow(1)
  headers.forEach((h, i) => (headerRow.getCell(i + 1).value = h))
  styleHeaderRow(headerRow)

  sheet.getColumn(1).width = 10
  sheet.getColumn(2).width = 45
  for (let c = 3; c <= headers.length; c++) sheet.getColumn(c).width = 14

  sortedItems.forEach((item, i) => {
    const unitPriced = item.itemKind === 'unit_price'
    const itemProgress = progressByItem.get(item.id)
    const price = priceByItem.get(item.id)
    const unitPrice = unitPriced ? (price?.unitPrice ?? null) : null
    const cost = unitPriced ? (price?.costPrice ?? null) : null
    const quantityToDate = unitPriced ? (itemProgress?.quantityToDate ?? 0) : null
    const valueToDate = unitPriced && unitPrice !== null && quantityToDate !== null ? quantityToDate * unitPrice : null
    const costToDate = unitPriced && cost !== null && quantityToDate !== null ? quantityToDate * cost : null
    const marginToDate = unitPriced ? computeMargin(quantityToDate ?? 0, cost, unitPrice) : null
    const remaining = unitPriced ? item.approximateQuantity - (quantityToDate ?? 0) : null
    const qtyFmt = quantityFormat(item.unit)

    const row = sheet.getRow(i + 2)
    let c = 1
    row.getCell(c++).value = item.itemNumber
    row.getCell(c++).value = item.description
    const approxCell = row.getCell(c++)
    approxCell.value = unitPriced ? item.approximateQuantity : '—'
    if (unitPriced) approxCell.numFmt = qtyFmt
    const qtyCell = row.getCell(c++)
    qtyCell.value = quantityToDate ?? '—'
    if (quantityToDate !== null) qtyCell.numFmt = qtyFmt
    const remainingCell = row.getCell(c++)
    remainingCell.value = remaining ?? '—'
    if (remaining !== null) remainingCell.numFmt = qtyFmt
    const percentCell = row.getCell(c++)
    if (item.itemKind === 'provisional_sum') {
      percentCell.value = '—'
    } else {
      percentCell.value = itemProgress?.proportionComplete ?? 0
      percentCell.numFmt = PERCENT_FORMAT
    }
    if (contract.viewRates) {
      const unitPriceCell = row.getCell(c++)
      unitPriceCell.value = unitPrice ?? '—'
      if (unitPrice !== null) unitPriceCell.numFmt = MONEY_FORMAT
      const valueCell = row.getCell(c++)
      valueCell.value = valueToDate !== null ? roundMoney(valueToDate) : '—'
      if (valueToDate !== null) valueCell.numFmt = MONEY_FORMAT
      const costCell = row.getCell(c++)
      costCell.value = costToDate !== null ? roundMoney(costToDate) : '—'
      if (costToDate !== null) costCell.numFmt = MONEY_FORMAT
      const marginCell = row.getCell(c++)
      marginCell.value = marginToDate !== null ? roundMoney(marginToDate) : '—'
      if (marginToDate !== null) marginCell.numFmt = MONEY_FORMAT
    }
  })
}

/** Builds the workbook without writing it anywhere — separated from `exportTrackerWorkbook` so it can be exercised directly (e.g. in the browser console, or a future test) without triggering a file download each time. */
export async function buildTrackerWorkbook(contract: MyContract): Promise<ExcelJS.Workbook> {
  const data = await loadData(contract)
  const workbook = new ExcelJS.Workbook()
  buildTrackerSheet(workbook, contract, data)
  buildRecordsSheet(workbook, data)
  buildSummarySheet(workbook, contract, data)
  return workbook
}

export async function exportTrackerWorkbook(contract: MyContract): Promise<void> {
  const workbook = await buildTrackerWorkbook(contract)
  const buffer = await workbook.xlsx.writeBuffer()
  const filename = `${contract.contractNo ?? contract.name}_NovaCore_${new Date().toISOString().slice(0, 10)}.xlsx`
  triggerDownload(buffer as ArrayBuffer, filename)
}
