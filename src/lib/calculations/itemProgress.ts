import type { ItemKind } from '../supabase/items'

export interface EffectiveQuantityRow {
  itemId: string
  quantity: number
}

/**
 * Sums quantity per item across rows already filtered down to the
 * effective set — this does not decide WHICH rows count (that's
 * quantity_records_effective's job, see effectiveEntries.ts and 0001), it only
 * aggregates what it's given. Rows for an item with no entries at all
 * simply produce no map entry; callers default to 0.
 */
export function placedToDateByItem(rows: readonly EffectiveQuantityRow[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const row of rows) {
    totals.set(row.itemId, (totals.get(row.itemId) ?? 0) + row.quantity)
  }
  return totals
}

/**
 * null, not 0 or 100%, when the figure is meaningless: a Lump Sum or
 * Provisional Sum item (approximate_quantity is always 1, and percent-
 * against-1 is not a real completion percentage — GC 52.03(c) pays a
 * Provisional Sum on value authorized in advance, not proportion), or an
 * approximate quantity of zero. Callers render null as "—", never as 0%.
 *
 * Keyed on item_kind (0012), not the unit string — the prior version
 * matched unit against a hardcoded ['Lump Sum', 'Prov. Sum'] list, which
 * silently missed the real seed data's "Provisional Sum" (full word,
 * not the abbreviation the list checked for) and rendered 0.0% for every
 * Provisional Sum item instead of "—".
 */
export function percentComplete(placed: number, approximateQuantity: number, itemKind: ItemKind): number | null {
  if (itemKind !== 'unit_price') return null
  if (approximateQuantity <= 0) return null
  return placed / approximateQuantity
}
