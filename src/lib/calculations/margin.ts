/**
 * Mirrors v_item_finance (0001, renamed by 0009) exactly — margin = quantity * (sell -
 * cost), null when either rate is missing (a missing rate is not a zero
 * rate, and must never silently read as one). Works for both "margin to
 * date" (quantity = placed_to_date, on the Dashboard) and "contract margin"
 * (quantity = bid_quantity, on the Rates screen) — same arithmetic either
 * way, only which quantity is passed in differs.
 */
export function margin(quantity: number, costPrice: number | null, unitPrice: number | null): number | null {
  if (costPrice === null || unitPrice === null) return null
  return quantity * (unitPrice - costPrice)
}

/**
 * (sell - cost) / sell, guarded on revenue > 0 rather than sell > 0 alone —
 * matches v_item_finance's guard exactly: a positive sell rate with
 * zero quantity placed still yields null, not a (correct but meaningless
 * before anything is placed) percentage.
 */
export function marginPercent(quantity: number, costPrice: number | null, unitPrice: number | null): number | null {
  if (costPrice === null || unitPrice === null) return null
  const revenue = quantity * unitPrice
  if (revenue <= 0) return null
  return (unitPrice - costPrice) / unitPrice
}
