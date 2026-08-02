import { supabase } from './client'

export interface LineItem {
  id: string
  projectId: string
  itemNo: string
  description: string
  unit: string
  bidQuantity: number
}

interface RawLineItemRow {
  id: string
  project_id: string
  item_no: string
  description: string
  unit: string
  bid_quantity: string
}

const LINE_ITEM_SELECT = 'id, project_id, item_no, description, unit, bid_quantity'

function mapLineItemRow(row: RawLineItemRow): LineItem {
  return {
    id: row.id,
    projectId: row.project_id,
    itemNo: row.item_no,
    description: row.description,
    unit: row.unit,
    bidQuantity: Number(row.bid_quantity),
  }
}

// .order('item_no') is a plain string sort (server-side, cheap baseline) —
// screens that need real numeric-aware ordering ("05.03.04" after
// "05.03.03", "04.10" after "04.09") re-sort client-side with
// compareItemCodes (see naturalSort.ts); Postgres has no natural-sort
// built in worth reaching for over that.
export async function fetchLineItems(projectId: string): Promise<LineItem[]> {
  const { data, error } = await supabase.from('line_items').select(LINE_ITEM_SELECT).eq('project_id', projectId).order('item_no')
  if (error) throw error
  return (data ?? []).map((row) => mapLineItemRow(row as unknown as RawLineItemRow))
}

/** Postgres 23505 (unique_violation) on line_items' (project_id, item_no) constraint surfaces as a readable message instead of raw constraint-name text. */
function readableLineItemError(error: { code?: string; message: string }, itemNo: string): Error {
  if (error.code === '23505') {
    return new Error(`Item code "${itemNo}" is already used on this project.`)
  }
  return new Error(error.message)
}

export interface LineItemInput {
  itemNo: string
  description: string
  unit: string
  bidQuantity: number
}

/** project_manager only, per RLS (line_items_write_pm). */
export async function createLineItem(projectId: string, input: LineItemInput): Promise<LineItem> {
  const { data, error } = await supabase
    .from('line_items')
    .insert({
      project_id: projectId,
      item_no: input.itemNo,
      description: input.description,
      unit: input.unit,
      bid_quantity: input.bidQuantity,
    })
    .select(LINE_ITEM_SELECT)
    .single()
  if (error) throw readableLineItemError(error, input.itemNo)
  return mapLineItemRow(data as unknown as RawLineItemRow)
}

/** project_manager only, per RLS (line_items_update_pm). */
export async function updateLineItem(id: string, input: LineItemInput): Promise<LineItem> {
  const { data, error } = await supabase
    .from('line_items')
    .update({
      item_no: input.itemNo,
      description: input.description,
      unit: input.unit,
      bid_quantity: input.bidQuantity,
    })
    .eq('id', id)
    .select(LINE_ITEM_SELECT)
    .single()
  if (error) throw readableLineItemError(error, input.itemNo)
  return mapLineItemRow(data as unknown as RawLineItemRow)
}
