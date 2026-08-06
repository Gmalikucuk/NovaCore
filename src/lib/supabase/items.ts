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

/**
 * Whether area applies to this Item's quantity, and how — set from the
 * contract documents, never inferred. quantity_is_area: the recorded
 * quantity IS the area (milling, pulverize). separately_measured: area is
 * a separate measured fact alongside quantity, driving an application
 * rate (paving lifts, shouldering). not_applicable: area has no meaning
 * here (Lump Sum, Provisional Sum, Each/Metre/Cubic Metre, stockpile
 * supply). null is a fourth, distinct state — genuinely unclassified, not
 * the same as a checked "no area" — see items_area_basis (0038).
 */
export type AreaBasis = 'quantity_is_area' | 'separately_measured' | 'not_applicable'

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
  /** GC 52.03(b) — Finance's own estimate of percent complete, lump_sum Items only (items_percent_only_lump_sum). Never inferred from dates, contract state, or any other Item's progress; null until Finance enters it, and null means absent, not zero. Earned value for the Item is percentComplete/100 * its own Ext. amount. */
  percentComplete: number | null
  /** GC 32.01/47.01 — value the Ministry has authorized in advance, provisional_sum Items only (items_provisional_fields_only_provisional). Never derived; this figure IS the Item's earned value once entered. */
  authorizedValue: number | null
  areaBasis: AreaBasis | null
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

/**
 * A Square-Metre Item's own quantity IS its area (Cold Mill, milling,
 * pulverize) — a second, independently-entered area figure for these
 * would duplicate quantity, not add information. Daily Entry uses this to
 * route the width-derived-area convenience-fill and disagreement check at
 * the QUANTITY field itself for these Items, rather than showing a
 * separate area input that could never mean anything different from
 * quantity.
 *
 * Reads the stored classification (items.area_basis, 0038) — no longer a
 * string match against unit. An unclassified Item (areaBasis === null)
 * reads as false here, the same as not_applicable: never inferred, never
 * assumed to be the common case.
 */
export function isAreaUnit(item: Pick<Item, 'areaBasis'>): boolean {
  return item.areaBasis === 'quantity_is_area'
}

/**
 * Items where an application rate is a real, measured fact — asphalt or
 * aggregate spread over a stretch (Level Course, Bottom/Intermediate
 * Lifts, Top Lift, Shouldering, Construct Base Course), as opposed to
 * material simply supplied and stockpiled. Only these get the
 * average-width/entered-area inputs; a stockpile delivery has no stretch
 * to have a width or an area over.
 *
 * Reads the stored classification (items.area_basis, 0038) — no longer a
 * unit-plus-item-number-prefix heuristic. That heuristic is exactly what
 * got "Shoulder Aggregate" (03.xx, supply, no area) and "Shouldering"
 * (04.xx/05.xx, applied, has area) right by convention, not by anything
 * stored; area_basis is what Finance/the PM actually entered from the
 * contract documents. An unclassified Item (areaBasis === null) reads as
 * false here, the same as not_applicable.
 */
export function isApplicationRateItem(item: Pick<Item, 'areaBasis'>): boolean {
  return item.areaBasis === 'separately_measured'
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
  percent_complete: string | null
  authorized_value: string | null
  area_basis: AreaBasis | null
}

const ITEM_SELECT = 'id, contract_id, item_number, description, unit, approximate_quantity, item_kind, provisional_sum, percent_complete, authorized_value, area_basis'

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
    percentComplete: row.percent_complete === null ? null : Number(row.percent_complete),
    authorizedValue: row.authorized_value === null ? null : Number(row.authorized_value),
    areaBasis: row.area_basis,
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
  /** Set from the contract documents by whoever is entering this Item — never inferred, never defaulted. Omitted (or explicit null) leaves the Item unclassified, which is the correct starting state, not an oversight. */
  areaBasis?: AreaBasis | null
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
      area_basis: input.areaBasis ?? null,
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
      area_basis: input.areaBasis ?? null,
    })
    .eq('id', id)
    .select(ITEM_SELECT)
    .single()
  if (error) throw readableItemError(error, input.itemNumber)
  return mapItemRow(data as unknown as RawItemRow)
}

/**
 * Finance's own estimate — never inferred, never defaulted. Gated the same
 * as setting a price (set_cost AND set_unit_price, items_earned_fields_
 * update_right), not create_items — this isn't a description edit, it's
 * the figure that determines a Lump Sum Item's earned value. The database
 * constraint (items_percent_only_lump_sum) is what actually stops this
 * being set on a non-lump_sum Item; this function doesn't re-check the
 * kind client-side beyond what the caller's own UI already restricts.
 */
export async function updateItemPercentComplete(id: string, percentComplete: number | null): Promise<void> {
  const { error } = await supabase.from('items').update({ percent_complete: percentComplete }).eq('id', id)
  if (error) throw error
}

/**
 * The Ministry's own authorization — same gating and the same "never
 * inferred" rule as percentComplete above. items_provisional_fields_only_
 * provisional is the database-level guard for kind.
 */
export async function updateItemAuthorizedValue(id: string, authorizedValue: number | null): Promise<void> {
  const { error } = await supabase.from('items').update({ authorized_value: authorizedValue }).eq('id', id)
  if (error) throw error
}
