// ─────────────────────────────────────────────────────────────────────────
// PM confirmation queue — flagging logic. Both flags are advisory, never
// blocking (per the brief): confirming an over-quantity or outlier record
// is still a one-click action, just an informed one.
// ─────────────────────────────────────────────────────────────────────────

/**
 * How far a pending record would push an Item past its Approximate Quantity
 * if confirmed as-is. `originalQuantity` is the quantity currently counted
 * toward quantityToDate from the record this one supersedes — null unless
 * this is a correction AND the original was itself confirmed (an
 * unconfirmed original contributes nothing today, so there's nothing to
 * subtract). Positive means over; zero or negative means not over.
 */
export function prospectiveOverage(
  record: { quantity: number; originalQuantity: number | null },
  progress: { quantityToDate: number; approximateQuantity: number },
): number {
  const prospectiveQuantityToDate = progress.quantityToDate + record.quantity - (record.originalQuantity ?? 0)
  return prospectiveQuantityToDate - progress.approximateQuantity
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * More than 3x the median of an Item's recent confirmed history — a
 * fat-fingered 9,000 where 900 was meant. Requires at least 3 recent
 * values before flagging anything: a median of one or two prior records is
 * not a baseline, it's noise, and would flag the second-ever record on any
 * Item constantly. No baseline is better than a fake one.
 */
export function isOutlier(quantity: number, recentQuantities: readonly number[]): boolean {
  if (recentQuantities.length < 3) return false
  return quantity > 3 * median(recentQuantities)
}
