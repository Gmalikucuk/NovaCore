import { supabase } from './client'

export interface EffectiveQuantityRow {
  itemId: string
  quantity: number
}

/**
 * Reads quantity_records_effective directly (0001, renamed by 0009) — the
 * supersession rule (confirmed, no confirmed successor) lives entirely in
 * that view's SQL. This never re-derives which rows are effective; it only
 * fetches what the view already decided, for itemProgress.ts's
 * placedToDateByItem() to aggregate. security_invoker=on means this is still
 * scoped by quantity_records_select_member underneath — every seat sees
 * this, quantities carry no price information on their own.
 */
export async function fetchEffectiveQuantities(contractId: string): Promise<EffectiveQuantityRow[]> {
  const { data, error } = await supabase
    .from('quantity_records_effective')
    .select('item_id, quantity')
    .eq('contract_id', contractId)
  if (error) throw error
  return (data ?? []).map((row) => ({
    itemId: row.item_id as string,
    quantity: Number(row.quantity),
  }))
}
