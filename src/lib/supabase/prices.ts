import { supabase } from './client'

export interface LineItemPrice {
  lineItemId: string
  costPrice: number | null
  sellPrice: number | null
  updatedBy: string | null
  updatedAt: string
}

interface RawPriceRow {
  line_item_id: string
  cost_price: string | null
  sell_price: string | null
  updated_by: string | null
  updated_at: string
}

const PRICE_SELECT = 'line_item_id, cost_price, sell_price, updated_by, updated_at'

function mapPriceRow(row: RawPriceRow): LineItemPrice {
  return {
    lineItemId: row.line_item_id,
    costPrice: row.cost_price === null ? null : Number(row.cost_price),
    sellPrice: row.sell_price === null ? null : Number(row.sell_price),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }
}

/**
 * Every priced row for a project. RLS (prices_select_finance) returns this
 * empty for a field seat rather than erroring — the finance wall is
 * structural (line_item_prices has no field grant at all, see 0002), not
 * something this function needs to enforce itself. A line item with no row
 * here at all is unpriced — the Rates screen's "still unpriced" callout is a
 * set-difference against fetchLineItems(), not a flag on this row.
 */
export async function fetchLineItemPrices(projectId: string): Promise<LineItemPrice[]> {
  const { data, error } = await supabase.from('line_item_prices').select(PRICE_SELECT).eq('project_id', projectId)
  if (error) throw error
  return (data ?? []).map((row) => mapPriceRow(row as unknown as RawPriceRow))
}

/**
 * Upsert on line_item_id (the table's primary key) — a line item's first
 * rate entry inserts the row, editing it later updates the same one.
 * costPrice/sellPrice stay null if left blank rather than defaulting to 0:
 * a missing rate is not a zero rate, and margin.ts's null-propagation
 * depends on that distinction reaching it intact. project_manager only, per
 * RLS (prices_insert_pm / prices_update_pm).
 */
export async function upsertLineItemPrice(input: {
  lineItemId: string
  projectId: string
  costPrice: number | null
  sellPrice: number | null
}): Promise<LineItemPrice> {
  const { data, error } = await supabase
    .from('line_item_prices')
    .upsert(
      {
        line_item_id: input.lineItemId,
        project_id: input.projectId,
        cost_price: input.costPrice,
        sell_price: input.sellPrice,
      },
      { onConflict: 'line_item_id' },
    )
    .select(PRICE_SELECT)
    .single()
  if (error) throw error
  return mapPriceRow(data as unknown as RawPriceRow)
}
