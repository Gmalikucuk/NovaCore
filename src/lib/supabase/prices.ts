import { supabase } from './client'

export interface ItemPrice {
  itemId: string
  costPrice: number | null
  unitPrice: number | null
  updatedBy: string | null
  updatedAt: string
}

interface RawPriceRow {
  item_id: string
  cost_price: string | null
  unit_price: string | null
  updated_by: string | null
  updated_at: string
}

const PRICE_SELECT = 'item_id, cost_price, unit_price, updated_by, updated_at'

function mapPriceRow(row: RawPriceRow): ItemPrice {
  return {
    itemId: row.item_id,
    costPrice: row.cost_price === null ? null : Number(row.cost_price),
    unitPrice: row.unit_price === null ? null : Number(row.unit_price),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }
}

/**
 * Every priced row for a contract. RLS (item_prices_select_right) returns this
 * empty for a field seat rather than erroring — the finance wall is
 * structural (item_prices has no field grant at all, see 0002), not
 * something this function needs to enforce itself. An item with no row
 * here at all is unpriced — the Rates screen's "still unpriced" callout is a
 * set-difference against fetchItems(), not a flag on this row.
 */
export async function fetchItemPrices(contractId: string): Promise<ItemPrice[]> {
  const { data, error } = await supabase.from('item_prices').select(PRICE_SELECT).eq('contract_id', contractId)
  if (error) throw error
  return (data ?? []).map((row) => mapPriceRow(row as unknown as RawPriceRow))
}

/**
 * Upsert on item_id (the table's primary key) — an item's first
 * rate entry inserts the row, editing it later updates the same one.
 * costPrice/unitPrice stay null if left blank rather than defaulting to 0:
 * a missing rate is not a zero rate, and margin.ts's null-propagation
 * depends on that distinction reaching it intact. project_manager only, per
 * RLS (item_prices_insert_right / item_prices_update_right).
 */
export async function upsertItemPrice(input: {
  itemId: string
  contractId: string
  costPrice: number | null
  unitPrice: number | null
}): Promise<ItemPrice> {
  const { data, error } = await supabase
    .from('item_prices')
    .upsert(
      {
        item_id: input.itemId,
        contract_id: input.contractId,
        cost_price: input.costPrice,
        unit_price: input.unitPrice,
      },
      { onConflict: 'item_id' },
    )
    .select(PRICE_SELECT)
    .single()
  if (error) throw error
  return mapPriceRow(data as unknown as RawPriceRow)
}
