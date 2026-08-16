import type { BidStatus, CostSource } from '../supabase/bids'

export const BID_STATUS_LABEL: Record<BidStatus, string> = {
  not_submitted: 'Not submitted',
  submitted: 'Submitted',
  won: 'Won',
  lost: 'Lost',
  no_award: 'No award',
  withdrawn: 'Withdrawn',
}

export const COST_SOURCE_LABEL: Record<CostSource, string> = {
  vendor_quote: 'Vendor quote',
  judgement: 'Judgement',
  calculated_build: 'Calculated build',
}

/**
 * quantity * sellPrice — a bid line's sell price is always a per-unit rate
 * (unlike items.cost_basis, there is no 'total' variant here; cost
 * assemblies are explicitly out of scope for this brief). Null propagates:
 * an unpriced line has no extended value, not zero.
 */
export function bidItemExtended(quantity: number, sellPrice: number | null): number | null {
  if (sellPrice === null) return null
  return quantity * sellPrice
}

/** Same rule, for cost — quantity * costPrice, always per-unit. */
export function bidItemCost(quantity: number, costPrice: number | null): number | null {
  if (costPrice === null) return null
  return quantity * costPrice
}

/** extended - cost, null when either is unknown — a missing rate is not a zero rate. */
export function bidItemMargin(quantity: number, sellPrice: number | null, costPrice: number | null): number | null {
  const extended = bidItemExtended(quantity, sellPrice)
  const cost = bidItemCost(quantity, costPrice)
  if (extended === null || cost === null) return null
  return extended - cost
}

/**
 * Sums only the non-null values — null when none are priced yet, not 0.
 * Same rule as margin.ts's sumOrNull, duplicated locally rather than
 * imported: this file has no other dependency on margin.ts, and importing
 * one function for this would be a heavier coupling than the four lines
 * it saves.
 */
export function sumOrNull(values: readonly (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null)
  return known.length === 0 ? null : known.reduce((sum, v) => sum + v, 0)
}

/**
 * How many of a bid's lines carry a cost, broken down by where that cost
 * came from — the "twelve judged, four quoted" read the brief asks for at
 * a glance. Lines with no cost at all are simply not counted anywhere here
 * (uncosted is not its own cost_source) — priced.length + uncosted count is
 * always the total line count, derivable by the caller if needed.
 */
export interface CostCoverage {
  vendorQuote: number
  judgement: number
  calculatedBuild: number
  uncosted: number
}

export function costCoverage(lines: readonly { costSource: CostSource | null }[]): CostCoverage {
  const coverage: CostCoverage = { vendorQuote: 0, judgement: 0, calculatedBuild: 0, uncosted: 0 }
  for (const line of lines) {
    if (line.costSource === 'vendor_quote') coverage.vendorQuote++
    else if (line.costSource === 'judgement') coverage.judgement++
    else if (line.costSource === 'calculated_build') coverage.calculatedBuild++
    else coverage.uncosted++
  }
  return coverage
}
