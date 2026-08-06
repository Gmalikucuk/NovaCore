import { supabase } from './client'

/**
 * GC 52.03's three payment bases (0012). unit_price is the only kind where
 * Approximate Quantity/percent-complete/a per-unit Cost or Unit Price mean
 * anything — a Lump Sum's approximate_quantity is always 1 (one lump), and
 * a Provisional Sum pays on value authorized in advance, not proportion.
 * See itemProgress.ts's percentComplete and the screens that render "—"
 * for the columns that don't apply to the other two kinds.
 */
export type ItemKind = 'unit_price' | 'lump_sum' | 'provisional_sum'

export interface Item {
  id: string
  contractId: string
  itemNumber: string
  description: string
  unit: string
  approximateQuantity: number
  itemKind: ItemKind
  /** Schedule 7's own Provisional Sum allowance — set only for provisional_sum Items (items_provisional_fields_only_provisional). This IS a provisional_sum Item's Ext. amount on Rates; it is never entered there, only read. */
  provisionalSum: number | null
}

/**
 * A quantity_records row only measures something for a unit_price Item —
 * a Lump Sum Item is paid on percentage complete (GC 52.03(b)) and a
 * Provisional Sum Item on value authorized in advance (GC 52.03(c)/47.01),
 * neither of which a quantity is a reading of. Both entry screens
 * (EntryScreen, QuantityRecordsScreen) filter their Item picker on this and
 * re-check it at submit time, rather than trusting the picker alone.
 */
export function isUnitPriceItem(item: Pick<Item, 'itemKind'>): boolean {
  return item.itemKind === 'unit_price'
}

interface RawItemRow {
  id: string
  contract_id: string
  item_number: string
  description: string
  unit: string
  approximate_quantity: string
  item_kind: ItemKind
  provisional_sum: string | null
}

const ITEM_SELECT = 'id, contract_id, item_number, description, unit, approximate_quantity, item_kind, provisional_sum'

function mapItemRow(row: RawItemRow): Item {
  return {
    id: row.id,
    contractId: row.contract_id,
    itemNumber: row.item_number,
    description: row.description,
    unit: row.unit,
    approximateQuantity: Number(row.approximate_quantity),
    itemKind: row.item_kind,
    provisionalSum: row.provisional_sum === null ? null : Number(row.provisional_sum),
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

export interface BulkItemInput {
  itemNumber: string
  description: string
  unit: string
  itemKind: ItemKind
  approximateQuantity: number
}

/**
 * One statement, every row or none — the Schedule 7 paste-a-block path
 * (Admin: create contract). A single INSERT with N rows is checked against
 * items_insert_right (create_items) per row inside the same statement, so a
 * rejection on any row rejects the whole batch rather than leaving Schedule
 * 7 partially entered with no clear record of which Items actually landed.
 */
export async function bulkCreateItems(contractId: string, inputs: BulkItemInput[]): Promise<Item[]> {
  const { data, error } = await supabase
    .from('items')
    .insert(
      inputs.map((input) => ({
        contract_id: contractId,
        item_number: input.itemNumber,
        description: input.description,
        unit: input.unit,
        item_kind: input.itemKind,
        approximate_quantity: input.approximateQuantity,
      })),
    )
    .select(ITEM_SELECT)
  if (error) {
    if (error.code === '23505') throw new Error('One of these Item numbers is already used on this contract.')
    throw new Error(error.message)
  }
  return (data ?? []).map((row) => mapItemRow(row as unknown as RawItemRow))
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
