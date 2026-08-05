export type CostBasis = 'per_unit' | 'total'

/**
 * cost_price turned into a dollar figure — the one place this arithmetic
 * lives, so every caller applies the same rule (0023). A total is a flat
 * figure that doesn't scale with quantity — a subcontract quote is due
 * regardless of how much has been placed so far — so 'total' bypasses
 * quantity entirely, on purpose, not by omission. A missing cost or a
 * missing basis both read as "unknown", never as zero.
 */
export function estimatedCost(quantity: number, costPrice: number | null, costBasis: CostBasis | null): number | null {
  if (costPrice === null || costBasis === null) return null
  return costBasis === 'total' ? costPrice : quantity * costPrice
}

/**
 * Mirrors v_item_finance exactly — margin = revenue - estimatedCost(), null
 * when either rate is missing (a missing rate is not a zero rate, and must
 * never silently read as one). Works for both "margin to date" (quantity =
 * placed_to_date) and "contract margin" (quantity = approximate_quantity) —
 * same arithmetic either way, only which quantity is passed in differs.
 */
export function margin(quantity: number, costPrice: number | null, unitPrice: number | null, costBasis: CostBasis | null): number | null {
  if (unitPrice === null) return null
  const cost = estimatedCost(quantity, costPrice, costBasis)
  if (cost === null) return null
  return quantity * unitPrice - cost
}

/**
 * margin / revenue, guarded on revenue > 0 rather than sell > 0 alone —
 * matches v_item_finance's guard exactly: a positive sell rate with zero
 * quantity placed still yields null, not a (correct but meaningless before
 * anything is placed) percentage. Generalised from the old per-unit-only
 * shortcut (unitPrice - costPrice) / unitPrice — identical when cost is a
 * rate (margin/revenue = qty(unit-cost) / qty*unit = (unit-cost)/unit) and
 * also correct when cost is a flat total, which the old shortcut never was.
 */
export function marginPercent(quantity: number, costPrice: number | null, unitPrice: number | null, costBasis: CostBasis | null): number | null {
  if (unitPrice === null) return null
  const revenue = quantity * unitPrice
  if (revenue <= 0) return null
  const m = margin(quantity, costPrice, unitPrice, costBasis)
  if (m === null) return null
  return m / revenue
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
