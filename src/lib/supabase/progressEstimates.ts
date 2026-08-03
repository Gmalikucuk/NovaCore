import { supabase } from './client'

/**
 * Per Item, summed across every progress_estimate to date — the Tracker's
 * "MoT Quantity"/"MoT Total" columns. 0010 deliberately populates nothing
 * (see that migration's own header: no UI for entering estimates yet), so
 * this returns an empty map today on every real contract — every MoT cell
 * renders `—`, which is the correct state, not a bug to work around.
 *
 * `v_progress_estimate_reconciliation` has no `item_id` column (0010 selects
 * `item_number` from the `items` join, not `id`) — keyed here by
 * `itemNumber`, so callers must join back to an Item the same way.
 */
export interface ProgressEstimateReconciliation {
  certifiedQuantityToDate: number | null
  certifiedValueToDate: number | null
  paidAmountToDate: number | null
}

interface RawReconciliationRow {
  item_number: string
  certified_quantity: string | null
  certified_value: string | null
  paid_amount: string | null
}

function sumKnown(existing: number | null, addend: string | null): number | null {
  if (addend === null) return existing
  return (existing ?? 0) + Number(addend)
}

export async function fetchProgressEstimateReconciliation(contractId: string): Promise<Map<string, ProgressEstimateReconciliation>> {
  const { data, error } = await supabase
    .from('v_progress_estimate_reconciliation')
    .select('item_number, certified_quantity, certified_value, paid_amount')
    .eq('contract_id', contractId)
  if (error) throw error

  const byItemNumber = new Map<string, ProgressEstimateReconciliation>()
  for (const row of (data ?? []) as unknown as RawReconciliationRow[]) {
    const existing = byItemNumber.get(row.item_number) ?? { certifiedQuantityToDate: null, certifiedValueToDate: null, paidAmountToDate: null }
    byItemNumber.set(row.item_number, {
      certifiedQuantityToDate: sumKnown(existing.certifiedQuantityToDate, row.certified_quantity),
      certifiedValueToDate: sumKnown(existing.certifiedValueToDate, row.certified_value),
      paidAmountToDate: sumKnown(existing.paidAmountToDate, row.paid_amount),
    })
  }
  return byItemNumber
}
