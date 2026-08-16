// ─────────────────────────────────────────────────────────────────────────
// The month detail's column control (Months + month detail redesign) —
// identity and Value this period are always shown, never in this set: the
// screen answers "what did this month earn," and neither the row's own
// name nor the one figure that answers that question has a reason to hide.
// Everything else here is optional, persisted per seat via
// user_view_preferences, resolved fresh on every load against the CURRENT
// contract and seat rather than trusted from what was saved — same
// discipline as resolveRatesColumns, same reason: a right revoked after a
// preference was saved must win immediately, not be masked by a stale
// checkbox state this seat can no longer reach.
//
// quantityInPeriod and valueToDate default ON (the rest of the proposed
// four-column default) but stay toggleable, same as Rates' Approximate
// quantity — a seat who wants the plain two-column money view can turn
// them off; nothing forces them on every seat forever.
// ─────────────────────────────────────────────────────────────────────────

export interface FinanceMonthColumnVisibility {
  quantityInPeriod: boolean
  valueToDate: boolean
  quantityToDate: boolean
  costInPeriod: boolean
  marginInPeriod: boolean
  costToDate: boolean
  marginToDate: boolean
}

/**
 * `costVisible` is this seat's own right to see cost/margin at all
 * (costTrackingVisible) — cost-family columns are forced false whenever
 * this is false, regardless of what a stale saved preference says, exactly
 * as resolveRatesColumns already does for Rates' own cost columns.
 */
export function resolveFinanceMonthColumns(raw: Record<string, unknown> | null, costVisible: boolean): FinanceMonthColumnVisibility {
  const source = raw ?? {}
  const bool = (key: string, fallback: boolean): boolean => (typeof source[key] === 'boolean' ? (source[key] as boolean) : fallback)
  return {
    quantityInPeriod: bool('quantityInPeriod', true),
    valueToDate: bool('valueToDate', true),
    quantityToDate: bool('quantityToDate', false),
    costInPeriod: costVisible && bool('costInPeriod', false),
    marginInPeriod: costVisible && bool('marginInPeriod', false),
    costToDate: costVisible && bool('costToDate', false),
    marginToDate: costVisible && bool('marginToDate', false),
  }
}
