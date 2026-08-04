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

/**
 * Sums only the non-null values — null when none are present at all, not 0.
 * `values.reduce((s, v) => s + (v ?? 0), 0)` would return 0 for an all-null
 * set, which reads as "we have zero margin/value" rather than "nothing
 * priced yet" — the money() formatter renders that 0 as "$0.00", the exact
 * inversion of how every per-row cell already renders an unpriced item
 * ("—", never $0.00). A partially priced contract still totals the rows
 * that ARE priced; only a wholly empty set is absent. Shared by
 * RatesScreen's contract-margin footer and OverviewScreen's month-detail
 * footer — both hit the identical all-null case on a contract with no
 * rates entered yet.
 */
export function sumOrNull(values: readonly (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null)
  return known.length === 0 ? null : known.reduce((sum, v) => sum + v, 0)
}
