import * as XLSX from 'xlsx'
import { supabase } from '../supabase/client'
import type { MyContract } from '../supabase/contracts'
import { fetchItems } from '../supabase/items'
import { fetchItemPrices } from '../supabase/prices'
import { fetchItemMonths, fetchItemProgress } from '../supabase/monthlyPeriods'
import { fetchContractQuantityRecords } from '../supabase/quantityRecords'
import { fetchProgressEstimateReconciliation, type ProgressEstimateReconciliation } from '../supabase/progressEstimates'
import { isEffective } from '../calculations/effectiveEntries'
import { compareItemCodes, sectionLabel, sectionPrefix } from '../calculations/naturalSort'
import { margin as computeMargin } from '../calculations/margin'
import { station } from '../format'
import { todayLocalDateString } from '../dateFormat'

async function fetchProfileNames(ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map()
  const { data, error } = await supabase.from('profiles').select('id, full_name').in('id', ids)
  if (error) throw error
  return new Map((data ?? []).map((p) => [p.id as string, p.full_name as string | null]))
}

/** Sets a number format on every numeric cell in a column — skipped for any cell that isn't a number (a lump-sum row's "45% complete" text, say), since forcing a format string onto a text cell doesn't apply and a blanket per-column format would be wrong for a column that legitimately mixes numbers and labels across item kinds. */
function formatNumericColumn(sheet: XLSX.WorkSheet, colIndex: number, rowCount: number, format: string) {
  for (let r = 1; r <= rowCount; r++) {
    const cell = sheet[XLSX.utils.encode_cell({ r, c: colIndex })]
    if (cell && cell.t === 'n') cell.z = format
  }
}

const QTY_FORMAT = '#,##0.00'
const MONEY_FORMAT = '$#,##0.00'
const PERCENT_FORMAT = '0.0%'

/**
 * One workbook, three sheets, built from the same queries the Tracker
 * screen itself uses — re-fetched here rather than passed in from the
 * screen's own state, trading one extra round-trip (an export is an
 * infrequent, user-initiated action, not a hot path) for a self-contained
 * function that doesn't entangle the screen's state management.
 *
 * The export mirrors the screen's rights exactly: a seat without
 * view_rates gets a workbook with no money columns AT ALL — the columns
 * are absent from the header row, not blanked — so the export can never
 * become a way around the finance wall extract_report itself doesn't
 * already gate.
 */
export async function exportTrackerWorkbook(contract: MyContract): Promise<void> {
  const [items, progress, prices, itemMonths, allRecords, reconciliation] = await Promise.all([
    fetchItems(contract.id),
    fetchItemProgress(contract.id),
    contract.viewRates ? fetchItemPrices(contract.id) : Promise.resolve([]),
    fetchItemMonths(contract.id),
    // Same scale caveat as the Tracker screen's own use of this fetch — see
    // TrackerScreen.tsx's comment at this call. Not repeating the full note
    // here since it's the same limitation, not a new one.
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
  const itemById = new Map(items.map((i) => [i.id, i]))
  const effectiveIds = new Set(allRecords.filter((r) => isEffective(r, allRecords)).map((r) => r.id))

  const periods = [...new Set(itemMonths.map((m) => m.periodMonth))].sort()
  const itemMonthByKey = new Map(itemMonths.map((m) => [`${m.itemId}|${m.periodMonth}`, m]))
  const sortedItems = [...items].sort((a, b) => compareItemCodes(a.itemNumber, b.itemNumber))

  const workbook = XLSX.utils.book_new()

  // ---------------------------------------------------------------------
  // Tracker sheet — the grid at month granularity, same section grouping
  // as the screen (a plain "Section" column here rather than merged
  // header rows, which don't translate cleanly to a flat spreadsheet).
  // ---------------------------------------------------------------------
  const trackerHeader = [
    'Section',
    'Item #',
    'Description',
    'Unit',
    'Approx. Qty',
    ...periods.flatMap((p) => (contract.viewRates ? [`${p} Qty`, `${p} $`] : [`${p} Qty`])),
    'Qty to Date',
    ...(contract.viewRates ? ['Value to Date', 'MoT Qty', 'MoT Total'] : []),
    'Remaining',
    '% Complete',
  ]
  const numericQtyCols: number[] = []
  const numericMoneyCols: number[] = []
  const numericPercentCols: number[] = []

  const trackerRows = sortedItems.map((item) => {
    const unitPriced = item.itemKind === 'unit_price'
    const itemProgress = progressByItem.get(item.id)
    const price = priceByItem.get(item.id)
    const unitPrice = unitPriced ? (price?.unitPrice ?? null) : null
    const quantityToDate = unitPriced ? (itemProgress?.quantityToDate ?? 0) : null
    const valueToDate = unitPriced && unitPrice !== null && quantityToDate !== null ? quantityToDate * unitPrice : null
    const remaining = unitPriced ? item.approximateQuantity - (quantityToDate ?? 0) : null
    const recon = reconciliation.get(item.itemNumber)

    const periodCells = periods.flatMap((period) => {
      const inPeriod = itemMonthByKey.get(`${item.id}|${period}`)
      const quantityInPeriod = unitPriced ? (inPeriod?.quantityInPeriod ?? 0) : null
      const valueInPeriod = unitPriced && unitPrice !== null && quantityInPeriod !== null ? quantityInPeriod * unitPrice : null
      return contract.viewRates ? [quantityInPeriod, valueInPeriod] : [quantityInPeriod]
    })

    const qtyToDateCell =
      item.itemKind === 'lump_sum'
        ? `${itemProgress?.percentComplete ?? '—'}% complete`
        : item.itemKind === 'provisional_sum'
          ? `${itemProgress?.authorizedValue ?? 0} of ${itemProgress?.provisionalSum ?? 0}`
          : quantityToDate

    return [
      sectionLabel(sectionPrefix(item.itemNumber)),
      item.itemNumber,
      item.description,
      item.unit,
      unitPriced ? item.approximateQuantity : null,
      ...periodCells,
      qtyToDateCell,
      ...(contract.viewRates ? [valueToDate, recon?.certifiedQuantityToDate ?? null, recon?.certifiedValueToDate ?? null] : []),
      remaining,
      item.itemKind === 'provisional_sum' ? null : (itemProgress?.proportionComplete ?? null),
    ]
  })

  const trackerSheet = XLSX.utils.aoa_to_sheet([trackerHeader, ...trackerRows])
  // Column indices: 4 = Approx Qty, then alternating Qty/$ per period, then
  // the right block — computed from the header layout above rather than
  // hardcoded, since the column count varies with view_rates and period count.
  numericQtyCols.push(4)
  let col = 5
  for (let i = 0; i < periods.length; i++) {
    numericQtyCols.push(col)
    col++
    if (contract.viewRates) {
      numericMoneyCols.push(col)
      col++
    }
  }
  const qtyToDateCol = col
  col++
  if (contract.viewRates) {
    numericMoneyCols.push(col) // Value to Date
    col++
    numericQtyCols.push(col) // MoT Qty
    col++
    numericMoneyCols.push(col) // MoT Total
    col++
  }
  const remainingCol = col
  col++
  const percentCol = col
  numericQtyCols.push(qtyToDateCol, remainingCol)
  numericPercentCols.push(percentCol)

  for (const c of numericQtyCols) formatNumericColumn(trackerSheet, c, trackerRows.length, QTY_FORMAT)
  for (const c of numericMoneyCols) formatNumericColumn(trackerSheet, c, trackerRows.length, MONEY_FORMAT)
  for (const c of numericPercentCols) formatNumericColumn(trackerSheet, c, trackerRows.length, PERCENT_FORMAT)
  XLSX.utils.book_append_sheet(workbook, trackerSheet, 'Tracker')

  // ---------------------------------------------------------------------
  // Records sheet — every quantity_records row, whatever its status.
  // ---------------------------------------------------------------------
  const recordsHeader = ['Work Date', 'Item #', 'Description', 'Location', 'Station From', 'Station To', 'Quantity', 'Unit', 'Status', 'Counts', 'Correction', 'Note', 'Entered By', 'Confirmed By']
  const recordsRows = [...allRecords]
    .sort((a, b) => a.workDate.localeCompare(b.workDate))
    .map((r) => {
      const item = itemById.get(r.itemId)
      return [
        r.workDate,
        item?.itemNumber ?? r.itemId,
        item?.description ?? '',
        r.location ?? '',
        r.stationFrom === null ? '' : station(r.stationFrom),
        r.stationTo === null ? '' : station(r.stationTo),
        r.quantity,
        item?.unit ?? '',
        r.status,
        effectiveIds.has(r.id) ? 'Yes' : 'No',
        r.supersedes !== null ? 'Yes' : 'No',
        r.note ?? '',
        namesById.get(r.createdBy) ?? '',
        r.confirmedBy ? (namesById.get(r.confirmedBy) ?? '') : '',
      ]
    })
  const recordsSheet = XLSX.utils.aoa_to_sheet([recordsHeader, ...recordsRows])
  formatNumericColumn(recordsSheet, 6, recordsRows.length, QTY_FORMAT)
  XLSX.utils.book_append_sheet(workbook, recordsSheet, 'Records')

  // ---------------------------------------------------------------------
  // Summary sheet — per Item, to-date figures only.
  // ---------------------------------------------------------------------
  const summaryHeader = ['Item #', 'Description', 'Approx. Qty', 'Qty to Date', 'Remaining', '% Complete', ...(contract.viewRates ? ['Unit Price', 'Value to Date', 'Cost to Date', 'Margin'] : [])]
  const summaryRows = sortedItems.map((item) => {
    const unitPriced = item.itemKind === 'unit_price'
    const itemProgress = progressByItem.get(item.id)
    const price = priceByItem.get(item.id)
    const unitPrice = unitPriced ? (price?.unitPrice ?? null) : null
    const cost = unitPriced ? (price?.costPrice ?? null) : null
    const quantityToDate = unitPriced ? (itemProgress?.quantityToDate ?? 0) : null
    const valueToDate = unitPriced && unitPrice !== null && quantityToDate !== null ? quantityToDate * unitPrice : null
    const costToDate = unitPriced && cost !== null && quantityToDate !== null ? quantityToDate * cost : null
    const remaining = unitPriced ? item.approximateQuantity - (quantityToDate ?? 0) : null
    const marginToDate = unitPriced ? computeMargin(quantityToDate ?? 0, cost, unitPrice) : null

    return [
      item.itemNumber,
      item.description,
      unitPriced ? item.approximateQuantity : null,
      quantityToDate,
      remaining,
      item.itemKind === 'provisional_sum' ? null : (itemProgress?.proportionComplete ?? null),
      ...(contract.viewRates ? [unitPrice, valueToDate, costToDate, marginToDate] : []),
    ]
  })
  const summarySheet = XLSX.utils.aoa_to_sheet([summaryHeader, ...summaryRows])
  formatNumericColumn(summarySheet, 2, summaryRows.length, QTY_FORMAT)
  formatNumericColumn(summarySheet, 3, summaryRows.length, QTY_FORMAT)
  formatNumericColumn(summarySheet, 4, summaryRows.length, QTY_FORMAT)
  formatNumericColumn(summarySheet, 5, summaryRows.length, PERCENT_FORMAT)
  if (contract.viewRates) {
    formatNumericColumn(summarySheet, 6, summaryRows.length, MONEY_FORMAT)
    formatNumericColumn(summarySheet, 7, summaryRows.length, MONEY_FORMAT)
    formatNumericColumn(summarySheet, 8, summaryRows.length, MONEY_FORMAT)
    formatNumericColumn(summarySheet, 9, summaryRows.length, MONEY_FORMAT)
  }
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary')

  const filename = `${contract.contractNo ?? contract.name}_NovaCore_${todayLocalDateString()}.xlsx`
  XLSX.writeFile(workbook, filename)
}
