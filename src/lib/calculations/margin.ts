/**
 * Mirrors v_line_item_finance (0001) exactly — margin = quantity * (sell -
 * cost), null when either rate is missing (a missing rate is not a zero
 * rate, and must never silently read as one). Works for both "margin to
 * date" (quantity = placed_to_date, on the Dashboard) and "contract margin"
 * (quantity = bid_quantity, on the Rates screen) — same arithmetic either
 * way, only which quantity is passed in differs.
 */
export function margin(quantity: number, costPrice: number | null, sellPrice: number | null): number | null {
  if (costPrice === null || sellPrice === null) return null
  return quantity * (sellPrice - costPrice)
}

/**
 * (sell - cost) / sell, guarded on revenue > 0 rather than sell > 0 alone —
 * matches v_line_item_finance's guard exactly: a positive sell rate with
 * zero quantity placed still yields null, not a (correct but meaningless
 * before anything is placed) percentage.
 */
export function marginPercent(quantity: number, costPrice: number | null, sellPrice: number | null): number | null {
  if (costPrice === null || sellPrice === null) return null
  const revenue = quantity * sellPrice
  if (revenue <= 0) return null
  return (sellPrice - costPrice) / sellPrice
}
