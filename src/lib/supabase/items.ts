import { supabase } from './client'

export interface Item {
  id: string
  contractId: string
  itemNumber: string
  description: string
  unit: string
  approximateQuantity: number
}

interface RawItemRow {
  id: string
  contract_id: string
  item_number: string
  description: string
  unit: string
  approximate_quantity: string
}

const ITEM_SELECT = 'id, contract_id, item_number, description, unit, approximate_quantity'

function mapItemRow(row: RawItemRow): Item {
  return {
    id: row.id,
    contractId: row.contract_id,
    itemNumber: row.item_number,
    description: row.description,
    unit: row.unit,
    approximateQuantity: Number(row.approximate_quantity),
  }
}

// .order('item_number') is a plain string sort (server-side, cheap baseline) —
// screens that need real numeric-aware ordering ("05.03.04" after
// "05.03.03", "04.10" after "04.09") re-sort client-side with
// compareItemCodes (see naturalSort.ts); Postgres has no natural-sort
// built in worth reaching for over that.
export async function fetchItems(contractId: string): Promise<Item[]> {
  const { data, error } = await supabase.from('items').select(ITEM_SELECT).eq('contract_id', contractId).order('item_number')
  if (error) throw error
  return (data ?? []).map((row) => mapItemRow(row as unknown as RawItemRow))
}

/** Postgres 23505 (unique_violation) on items' (contract_id, item_number) constraint surfaces as a readable message instead of raw constraint-name text. */
function readableItemError(error: { code?: string; message: string }, itemNumber: string): Error {
  if (error.code === '23505') {
    return new Error(`Item code "${itemNumber}" is already used on this contract.`)
  }
  return new Error(error.message)
}

export interface ItemInput {
  itemNumber: string
  description: string
  unit: string
  approximateQuantity: number
}

/** project_manager only, per RLS (items_insert_right). */
export async function createItem(contractId: string, input: ItemInput): Promise<Item> {
  const { data, error } = await supabase
    .from('items')
    .insert({
      contract_id: contractId,
      item_number: input.itemNumber,
      description: input.description,
      unit: input.unit,
      approximate_quantity: input.approximateQuantity,
    })
    .select(ITEM_SELECT)
    .single()
  if (error) throw readableItemError(error, input.itemNumber)
  return mapItemRow(data as unknown as RawItemRow)
}

/** project_manager only, per RLS (items_update_right). */
export async function updateItem(id: string, input: ItemInput): Promise<Item> {
  const { data, error } = await supabase
    .from('items')
    .update({
      item_number: input.itemNumber,
      description: input.description,
      unit: input.unit,
      approximate_quantity: input.approximateQuantity,
    })
    .eq('id', id)
    .select(ITEM_SELECT)
    .single()
  if (error) throw readableItemError(error, input.itemNumber)
  return mapItemRow(data as unknown as RawItemRow)
}
