import { isLumpUnit } from '../lineItemUnits'

export interface EffectiveQuantityRow {
  lineItemId: string
  quantity: number
}

/**
 * Sums quantity per line item across rows already filtered down to the
 * effective set — this does not decide WHICH rows count (that's
 * daily_entries_effective's job, see effectiveEntries.ts and 0001), it only
 * aggregates what it's given. Rows for a line item with no entries at all
 * simply produce no map entry; callers default to 0.
 */
export function placedToDateByItem(rows: readonly EffectiveQuantityRow[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const row of rows) {
    totals.set(row.lineItemId, (totals.get(row.lineItemId) ?? 0) + row.quantity)
  }
  return totals
}

/**
 * null, not 0 or 100%, when the figure is meaningless: a Lump Sum / Prov.
 * Sum item (bid_quantity is typically 1, and percent-against-1 is not a
 * real completion percentage — see the Line Items brief), or a bid quantity
 * of zero. Callers render null as "—", never as 0%.
 */
export function percentComplete(placed: number, bidQuantity: number, unit: string): number | null {
  if (isLumpUnit(unit)) return null
  if (bidQuantity <= 0) return null
  return placed / bidQuantity
}
