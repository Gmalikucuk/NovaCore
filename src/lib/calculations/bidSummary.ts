import type { ItemKind } from '../supabase/items'
import { estimatedCost, sumOrNull, type CostBasis } from './margin'

/**
 * Rates as a bid summary (Ext. cost, Ext. amount, Margin, Margin %) —
 * one set of formulas, three row shapes. unit_price is the general case
 * (§1's own formulas, unchanged). lump_sum has no quantity to extend a
 * rate against — the whole point of cost_basis = 'total' (0023) is that
 * costPrice/unitPrice ARE already the extended figures, so extCost still
 * routes through estimatedCost() (basis-aware, quantity-ignoring when
 * total) but extAmount is the stored unitPrice taken directly, never
 * multiplied by approximate_quantity (which a Lump Sum Item has no
 * reliable value for regardless — Schedule 7 gives it none). provisional_sum
 * has no cost and no margin, structurally, not just currently unentered:
 * the contractor is reimbursed at authorized value, so both stay null no
 * matter what item_prices happens to hold for that row.
 */
export interface RowFinancials {
  extCost: number | null
  extAmount: number | null
  margin: number | null
  marginPercent: number | null
}

export interface RowFinancialsInput {
  itemKind: ItemKind
  approximateQuantity: number
  /** items.provisional_sum — the Ext. amount source for a provisional_sum Item. Ignored for the other two kinds. */
  provisionalSum: number | null
  costPrice: number | null
  costBasis: CostBasis | null
  unitPrice: number | null
}

export function rowFinancials(input: RowFinancialsInput): RowFinancials {
  if (input.itemKind === 'provisional_sum') {
    return { extCost: null, extAmount: input.provisionalSum, margin: null, marginPercent: null }
  }
  const extCost = estimatedCost(input.approximateQuantity, input.costPrice, input.costBasis)
  const extAmount =
    input.itemKind === 'lump_sum' ? input.unitPrice : input.unitPrice === null ? null : input.approximateQuantity * input.unitPrice
  // MARGIN, NOT MARKUP — of revenue (Ext. amount), never of cost. A missing
  // extCost or extAmount reads as unknown, never as zero (sumOrNull's own
  // reasoning, one level down).
  const margin = extAmount === null || extCost === null ? null : extAmount - extCost
  const marginPercent = margin === null || extAmount === null || extAmount <= 0 ? null : margin / extAmount
  return { extCost, extAmount, margin, marginPercent }
}

export interface Coverage {
  count: number
  total: number
}

export interface Aggregate {
  extCostSum: number | null
  costCoverage: Coverage
  extAmountSum: number | null
  marginSum: number | null
  marginCoverage: Coverage
  marginPercent: number | null
}

/**
 * A section subtotal or the grand total — same shape either way, just a
 * different slice of rows. Ext. amount never carries a coverage note (every
 * Item has a real tendered figure once transcription finishes — cost may
 * permanently stay partial, Ext. amount is only ever mid-transcription
 * partial); cost and margin do, since Keywest may never cost every Item.
 * provisional_sum rows are excluded from both denominators — cost/margin
 * were never applicable there, not currently-missing.
 */
export function aggregateFinancials(rows: readonly { itemKind: ItemKind; financials: RowFinancials }[]): Aggregate {
  const costApplicable = rows.filter((r) => r.itemKind !== 'provisional_sum')
  const extCostSum = sumOrNull(costApplicable.map((r) => r.financials.extCost))
  const costCoverage = { count: costApplicable.filter((r) => r.financials.extCost !== null).length, total: costApplicable.length }
  const extAmountSum = sumOrNull(rows.map((r) => r.financials.extAmount))
  const marginSum = sumOrNull(costApplicable.map((r) => r.financials.margin))
  const marginCoverage = { count: costApplicable.filter((r) => r.financials.margin !== null).length, total: costApplicable.length }
  // Blended against the SAME subset's own revenue, not the grand Ext.
  // amount — provisional_sum's pass-through reimbursement was never a
  // candidate for margin, so it shouldn't dilute the percentage either.
  const marginApplicableAmount = sumOrNull(costApplicable.map((r) => r.financials.extAmount))
  const marginPercent = marginSum !== null && marginApplicableAmount !== null && marginApplicableAmount > 0 ? marginSum / marginApplicableAmount : null
  return { extCostSum, costCoverage, extAmountSum, marginSum, marginCoverage, marginPercent }
}

export type MarginBand = 'below' | 'neutral' | 'above'

/**
 * Bands marginPercent into bottom/middle/top third of this SAME contract's
 * own priced rows — never a fixed threshold (NovaCore has no basis to judge
 * "15% is bad" on someone else's contract). Rows with no cost simply never
 * get an entry in the returned map — absent is not low margin. Needs at
 * least 3 priced rows to say anything about relative position at all; fewer
 * than that, every row is left unbanded rather than forcing a meaningless
 * split.
 */
export function marginBands(rows: readonly { rowId: string; marginPercent: number | null }[]): Map<string, MarginBand> {
  const priced = rows.filter((r): r is { rowId: string; marginPercent: number } => r.marginPercent !== null)
  const bands = new Map<string, MarginBand>()
  if (priced.length < 3) return bands
  const sorted = [...priced].sort((a, b) => a.marginPercent - b.marginPercent)
  const third = sorted.length / 3
  sorted.forEach((r, i) => {
    const band: MarginBand = i < third ? 'below' : i < third * 2 ? 'neutral' : 'above'
    bands.set(r.rowId, band)
  })
  return bands
}

export interface TenderReconciliation {
  matches: boolean
  /** extAmountSum − tenderPrice, in cents, signed — positive means the transcribed total is OVER the tendered price. Compared in cents so float drift never produces a false mismatch. */
  differenceCents: number
}

/** Never derived from extAmountSum — tenderPrice is entered from the award document by a person; deriving it from the sum being checked would make the check tautological. */
export function reconcileTenderPrice(extAmountSum: number, tenderPrice: number): TenderReconciliation {
  const differenceCents = Math.round(extAmountSum * 100) - Math.round(tenderPrice * 100)
  return { matches: differenceCents === 0, differenceCents }
}
