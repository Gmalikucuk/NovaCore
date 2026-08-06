import type { ItemKind } from '../supabase/items'
import { sumOrNull } from './margin'

// ─────────────────────────────────────────────────────────────────────────
// Projected versus actual — what was tendered against what has been earned,
// on Keywest's own measure: recorded quantity x Unit Price, never the
// Ministry's certified/approved/paid figure (progress_estimates models that
// separately). Two buckets, kept apart deliberately (see the brief this
// implements: "Do not compute a combined completion percentage anywhere.
// Quantity-weighted completion has been removed from this product twice."):
//
//   measuredRollup   — unit_price Items, where a real quantity exists.
//                      Projected = Approximate Quantity x Unit Price.
//                      Earned    = recorded quantity x Unit Price.
//                      percent is real here, and can honestly exceed 100% —
//                      over-quantity is revenue above tender, not a fault.
//
//   unmeasuredRollup — lump_sum and provisional_sum Items, where no
//                      quantity exists at all. Tendered value plus whatever
//                      Finance has recorded as earned (percentComplete for
//                      lump_sum, authorizedValue for provisional_sum, both
//                      entered by a person — never inferred, see
//                      unmeasuredEarned). No percent is computed for this
//                      bucket, full stop — there is no quantity to derive
//                      one from, and "earned/tendered" would silently
//                      re-invent the blended figure this file exists to
//                      avoid one Item at a time.
//
// Both rollups return null (absent), never 0, when nothing is on file —
// sumOrNull already carries that rule; the only new discipline here is not
// letting a false 0% or $0.00 leak in at the call site.
// ─────────────────────────────────────────────────────────────────────────

export interface Coverage {
  count: number
  total: number
}

export interface MeasuredRollup {
  projected: number | null
  earned: number | null
  /** earned / projected — can exceed 1 (over-quantity, a gain, not a fault). Null whenever either side is null, or projected is 0. */
  percent: number | null
  /** How many unit_price Items actually have a Unit Price on file — both projected and earned need it, so one coverage figure covers both. */
  coverage: Coverage
}

export interface MeasuredRow {
  approximateQuantity: number
  /** Recorded quantity to date — 0 is a real, known fact (nothing placed yet), never absent; only unitPrice being null makes a row's contribution absent. */
  quantityToDate: number
  unitPrice: number | null
}

export function measuredRollup(rows: readonly MeasuredRow[]): MeasuredRollup {
  const priced = rows.filter((r) => r.unitPrice !== null)
  const projected = sumOrNull(rows.map((r) => (r.unitPrice === null ? null : r.approximateQuantity * r.unitPrice)))
  const earned = sumOrNull(rows.map((r) => (r.unitPrice === null ? null : r.quantityToDate * r.unitPrice)))
  const percent = projected !== null && projected > 0 && earned !== null ? earned / projected : null
  return { projected, earned, percent, coverage: { count: priced.length, total: rows.length } }
}

export interface UnmeasuredRow {
  itemKind: ItemKind
  /** This Item's own tendered value — extAmount from rowFinancials (bidSummary.ts): the stored total for lump_sum, provisionalSum for provisional_sum. Computed by the caller, not re-derived here, so this file never has to know how a total is priced. */
  tendered: number | null
  /** items.percent_complete — lump_sum only. */
  percentComplete: number | null
  /** items.authorized_value — provisional_sum only. */
  authorizedValue: number | null
}

/**
 * A single Item's earned value on the "not quantity-measured" side.
 * lump_sum: percentComplete/100 x its own tendered amount. provisional_sum:
 * authorizedValue directly (the authorization IS the earned figure, GC
 * 47.01 — no proration against anything else). Null whenever the input
 * Finance would enter is itself null — never defaulted to 0, and never
 * derived from a date, contract state, or any other Item.
 */
export function unmeasuredEarned(row: Pick<UnmeasuredRow, 'itemKind' | 'tendered' | 'percentComplete' | 'authorizedValue'>): number | null {
  if (row.itemKind === 'lump_sum') {
    return row.percentComplete === null || row.tendered === null ? null : (row.percentComplete / 100) * row.tendered
  }
  if (row.itemKind === 'provisional_sum') return row.authorizedValue
  return null
}

export interface UnmeasuredRollup {
  tendered: number | null
  earned: number | null
  /** How many lump_sum/provisional_sum Items have an earned figure on file yet — Finance hasn't entered every one. */
  coverage: Coverage
}

export function unmeasuredRollup(rows: readonly UnmeasuredRow[]): UnmeasuredRollup {
  const earnedPerRow = rows.map((r) => unmeasuredEarned(r))
  const tendered = sumOrNull(rows.map((r) => r.tendered))
  const earned = sumOrNull(earnedPerRow)
  return { tendered, earned, coverage: { count: earnedPerRow.filter((e) => e !== null).length, total: rows.length } }
}
