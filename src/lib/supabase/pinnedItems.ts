import { supabase } from './client'

/**
 * A seat's chosen set of Items to watch on a contract's Overview (0015) —
 * replaces the removed quantity-weighted "Contract complete" figure.
 * Per-seat and per-contract: the same person keeps the same pins moving
 * between devices, and different people on the same contract can watch
 * different Items. RLS (pinned_items_select_own) already scopes every read
 * to the caller's own rows; nothing here needs to filter by user again.
 */
export interface PinnedItem {
  id: string
  contractId: string
  itemId: string
}

interface RawPinnedItemRow {
  id: string
  contract_id: string
  item_id: string
}

const PIN_SELECT = 'id, contract_id, item_id'

function mapPinRow(row: RawPinnedItemRow): PinnedItem {
  return { id: row.id, contractId: row.contract_id, itemId: row.item_id }
}

export async function fetchPinnedItems(contractId: string): Promise<PinnedItem[]> {
  const { data, error } = await supabase.from('pinned_items').select(PIN_SELECT).eq('contract_id', contractId)
  if (error) throw error
  return (data ?? []).map((row) => mapPinRow(row as unknown as RawPinnedItemRow))
}

/**
 * Only a unit_price Item on this contract can be pinned — enforced at the
 * insert policy (pinned_items_insert_own), not just here. auth.uid() is
 * read server-side via the RLS check itself; user_id is still sent
 * explicitly because the policy's WITH CHECK compares it against
 * auth.uid(), same pattern as quantity_records' created_by.
 */
export async function pinItem(contractId: string, itemId: string): Promise<PinnedItem> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in.')

  const { data, error } = await supabase
    .from('pinned_items')
    .insert({ contract_id: contractId, user_id: user.id, item_id: itemId })
    .select(PIN_SELECT)
    .single()
  if (error) throw error
  return mapPinRow(data as unknown as RawPinnedItemRow)
}

/** Unpinning is deleting the pin row itself — RLS (pinned_items_delete_own) confirms it's the caller's own. */
export async function unpinItem(pinId: string): Promise<void> {
  const { error } = await supabase.from('pinned_items').delete().eq('id', pinId)
  if (error) throw error
}
