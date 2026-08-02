import { supabase } from './client'

export interface EffectiveEntryRow {
  lineItemId: string
  quantity: number
}

/**
 * Reads daily_entries_effective directly (0001) — the supersession rule
 * (confirmed, no confirmed successor) lives entirely in that view's SQL.
 * This never re-derives which rows are effective; it only fetches what the
 * view already decided, for lineItemProgress.ts's placedToDateByItem() to
 * aggregate. security_invoker=on means this is still scoped by
 * entries_select_member underneath — every role sees this, quantities carry
 * no price information on their own.
 */
export async function fetchEffectiveQuantities(projectId: string): Promise<EffectiveEntryRow[]> {
  const { data, error } = await supabase
    .from('daily_entries_effective')
    .select('line_item_id, quantity')
    .eq('project_id', projectId)
  if (error) throw error
  return (data ?? []).map((row) => ({
    lineItemId: row.line_item_id as string,
    quantity: Number(row.quantity),
  }))
}
