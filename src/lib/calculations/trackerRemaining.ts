/**
 * Tracker and TrackerItem each used to re-derive "how much is left" and
 * "is it over" inline, independently, from approximateQuantity and
 * quantityToDate — the same two-line formula in two files. Both now read
 * v_item_progress_rate's own quantityRemaining/isOverQuantity instead of
 * re-deriving the over/under DECISION; this is the one piece the view
 * doesn't already answer — quantityRemaining is clamped to 0 there
 * (greatest(approximateQuantity - quantityToDate, 0)), so it can't express
 * "how far over," and the magnitude for that one case is recovered here,
 * from the same to-date figure the view already computed, not a second
 * source.
 */
export interface RemainingDisplay {
  isOverQuantity: boolean
  /** Always >= 0 — how much remains (under) or how much past Approximate Quantity (over). Which one it means is isOverQuantity. */
  amount: number
}

export function remainingDisplay(progress: { approximateQuantity: number; quantityToDate: number; quantityRemaining: number; isOverQuantity: boolean }): RemainingDisplay {
  return progress.isOverQuantity
    ? { isOverQuantity: true, amount: progress.quantityToDate - progress.approximateQuantity }
    : { isOverQuantity: false, amount: progress.quantityRemaining }
}
