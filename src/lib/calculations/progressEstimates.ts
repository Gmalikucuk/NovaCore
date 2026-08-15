// ─────────────────────────────────────────────────────────────────────────
// Progress estimates (GC 52.00) — "Claimed comes from records; certified
// comes from the Ministry." This module is the arithmetic connecting the
// two: proposing a claim from what's already been confirmed, and stating
// the gap between claimed and certified once both exist. No submission
// logic, no reconciliation against actual_cost_entries, no document
// generation — see migration 0041 (write path/freeze/history) and
// src/lib/supabase/progressEstimates.ts (data layer) for the rest of the
// cycle.
// ─────────────────────────────────────────────────────────────────────────

import type { ItemKind } from '../supabase/items'
import type { ProductionRecord } from './productionCurve'

/**
 * Which of progress_estimate_items' three claimed/certified column pairs
 * is live for a given Item kind — GC 52.03: unit_price is measured
 * by quantity, lump_sum by percent complete (52.03(b)), provisional_sum by
 * an authorized value taken directly (52.03(c)/47.01). Mirrors the
 * unitPriced branch FinanceMonthScreen already uses for the identical
 * split, applied here to progress_estimate_items' parallel columns instead
 * of quantity/value.
 */
export type ClaimField = 'quantity' | 'percent' | 'value'

export function claimFieldForKind(itemKind: ItemKind): ClaimField {
  if (itemKind === 'unit_price') return 'quantity'
  if (itemKind === 'lump_sum') return 'percent'
  return 'value'
}

export interface ProposedClaim {
  itemId: string
  claimedQuantity: number
  claimedValue: number | null
}

/**
 * Claimed comes from records — for unit_price Items only, the confirmed
 * effective quantity recorded within [periodStart, periodEnd] inclusive
 * (`records` is expected already filtered to confirmed/effective, same
 * precondition as every other ProductionRecord caller), summed per Item
 * and priced at its current unit price. Lump Sum and Provisional Sum
 * Items have no quantity_records to propose from at all — their claimed
 * figure is a percent complete or an authorized value, entered directly,
 * never measured — so this proposes nothing for them; those lines start
 * blank and are entered by hand, same as every certified_* figure already
 * must be regardless of kind.
 */
export function proposeClaimedFromRecords(
  records: readonly ProductionRecord[],
  periodStart: string,
  periodEnd: string,
  unitPriceByItem: ReadonlyMap<string, number | null>,
): ProposedClaim[] {
  const totals = new Map<string, number>()
  for (const r of records) {
    if (r.workDate < periodStart || r.workDate > periodEnd) continue
    totals.set(r.itemId, (totals.get(r.itemId) ?? 0) + r.quantity)
  }
  return [...totals.entries()].map(([itemId, claimedQuantity]) => {
    const unitPrice = unitPriceByItem.get(itemId) ?? null
    return { itemId, claimedQuantity, claimedValue: unitPrice === null ? null : claimedQuantity * unitPrice }
  })
}

/**
 * certified - claimed, unclamped and sign-preserving — the gap as it
 * stands, not an error to clamp away (the same "show the gap, name
 * nothing as wrong" neutrality as the production curve's surplus
 * handling). Null whenever either side is unknown — not yet certified, or
 * not yet claimed — never coerced to 0, which would silently read "not
 * certified yet" as "certified at zero." The one arithmetic op divergence
 * needs, reused identically for quantity variance, percent variance, and
 * value variance: all three follow this same certified-minus-claimed
 * shape, whichever field claimFieldForKind() says is live for that line.
 */
export function variance(claimed: number | null, certified: number | null): number | null {
  if (claimed === null || certified === null) return null
  return certified - claimed
}

/**
 * Quantity to date — previous plus current, computed, never stored (§1).
 * Null only when BOTH sides are unknown — nothing on record at all.
 * previousQuantity's own null means "no prior claim exists" (0046's
 * previous_quantity is only ever null for that reason, by construction —
 * see the column comment) and contributes 0; claimedQuantity null means
 * "nothing typed this period yet" and *also* contributes 0 — the running
 * total up to the prior period is still a real, known fact even when this
 * period hasn't been entered. Getting this wrong previously lost real
 * progress: an Item with a nonzero previousQuantity but nothing claimed in
 * a given period fed a null into fetchPriorClaimQuantities, so the next
 * claim's own previousQuantity — carried forward once at creation and
 * frozen from then on — silently reset to null instead of preserving the
 * running total.
 */
export function quantityToDate(previousQuantity: number | null, claimedQuantity: number | null): number | null {
  if (previousQuantity === null && claimedQuantity === null) return null
  return (previousQuantity ?? 0) + (claimedQuantity ?? 0)
}

/**
 * A quantity as a percent of Approximate Quantity — the one ratio §2 needs
 * twice (percent to date, percent projected), against the same
 * denominator each time. Over 100% is a gain, not a fault (GC 52.04); this
 * function does not clamp it, same neutrality as variance() above.
 */
export function percentOfApproximate(quantity: number | null, approximateQuantity: number): number | null {
  if (quantity === null || approximateQuantity <= 0) return null
  return (quantity / approximateQuantity) * 100
}

/**
 * The projected final quantity's dollar difference against the tendered
 * extended amount (Approximate Quantity × Unit Price) — §2's own example:
 * "Schedule I projected $116,875.07 over the tendered total." Positive is
 * a gain (projected above tender), same neutral-gap convention as
 * variance() — never described as an error.
 */
export function projectedValueVariance(projectedQuantity: number | null, approximateQuantity: number, unitPrice: number | null): number | null {
  if (projectedQuantity === null || unitPrice === null) return null
  return (projectedQuantity - approximateQuantity) * unitPrice
}

/** Approximate Quantity × Unit Price — the tendered extended amount, shown in the redesigned claim screen's expanded panel as the reference figure a projection is measured against. Null when Unit Price isn't on file, never $0. */
export function tenderedExtendedAmount(approximateQuantity: number, unitPrice: number | null): number | null {
  if (unitPrice === null) return null
  return approximateQuantity * unitPrice
}
