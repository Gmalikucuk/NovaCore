import { supabase } from './client'
import type { ItemKind } from './items'

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

// ─────────────────────────────────────────────────────────────────────────
// The Finance write path (0041) — building a progress estimate, entering
// the Ministry's certified figures, moving it through draft/submitted/
// received/reconciled. Gated by RLS on set_cost AND set_unit_price, same
// as item_prices; every function below relies on that, not on a
// client-side check of its own.
// ─────────────────────────────────────────────────────────────────────────

export type ProgressEstimateStatus = 'draft' | 'submitted' | 'received' | 'reconciled'

export interface ProgressEstimate {
  id: string
  contractId: string
  periodStart: string
  periodEnd: string
  ministryReference: string | null
  status: ProgressEstimateStatus
  estimateDate: string | null
  note: string | null
  createdBy: string | null
  createdAt: string
}

interface RawProgressEstimateRow {
  id: string
  contract_id: string
  period_start: string
  period_end: string
  ministry_reference: string | null
  status: ProgressEstimateStatus
  estimate_date: string | null
  note: string | null
  created_by: string | null
  created_at: string
}

const ESTIMATE_SELECT = 'id, contract_id, period_start, period_end, ministry_reference, status, estimate_date, note, created_by, created_at'

function mapEstimateRow(row: RawProgressEstimateRow): ProgressEstimate {
  return {
    id: row.id,
    contractId: row.contract_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    ministryReference: row.ministry_reference,
    status: row.status,
    estimateDate: row.estimate_date,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

/** Every progress estimate on a contract, newest period first — the list screen's source. RLS (view_rates) returns this empty for a field seat, same structural wall as fetchItemPrices. */
export async function fetchProgressEstimates(contractId: string): Promise<ProgressEstimate[]> {
  const { data, error } = await supabase.from('progress_estimates').select(ESTIMATE_SELECT).eq('contract_id', contractId).order('period_end', { ascending: false })
  if (error) throw error
  return (data ?? []).map((row) => mapEstimateRow(row as unknown as RawProgressEstimateRow))
}

export async function fetchProgressEstimate(id: string): Promise<ProgressEstimate | null> {
  const { data, error } = await supabase.from('progress_estimates').select(ESTIMATE_SELECT).eq('id', id).maybeSingle()
  if (error) throw error
  return data ? mapEstimateRow(data as unknown as RawProgressEstimateRow) : null
}

export interface ProgressEstimateItem {
  id: string
  progressEstimateId: string
  itemId: string
  itemNumber: string
  description: string
  unit: string
  itemKind: ItemKind
  claimedQuantity: number | null
  certifiedQuantity: number | null
  claimedPercent: number | null
  certifiedPercent: number | null
  claimedValue: number | null
  certifiedValue: number | null
  paidAmount: number | null
  disputed: boolean
  varianceNote: string | null
}

interface RawProgressEstimateItemRow {
  id: string
  progress_estimate_id: string
  item_id: string
  claimed_quantity: string | null
  certified_quantity: string | null
  claimed_percent: string | null
  certified_percent: string | null
  claimed_value: string | null
  certified_value: string | null
  paid_amount: string | null
  disputed: boolean
  variance_note: string | null
  items: { item_number: string; description: string; unit: string; item_kind: ItemKind } | null
}

// progress_estimate_items carries two FKs to items (0010): the plain
// item_id one, and the composite (item_id, contract_id) one that cross-
// checks an Item actually belongs to this estimate's contract. A bare
// `items!inner` embed hint is therefore ambiguous (PGRST201) — it must
// name the specific single-column constraint.
const ESTIMATE_ITEM_SELECT =
  'id, progress_estimate_id, item_id, claimed_quantity, certified_quantity, claimed_percent, certified_percent, claimed_value, certified_value, paid_amount, disputed, variance_note, ' +
  'items!progress_estimate_items_item_id_fkey ( item_number, description, unit, item_kind )'

function mapEstimateItemRow(row: RawProgressEstimateItemRow): ProgressEstimateItem {
  return {
    id: row.id,
    progressEstimateId: row.progress_estimate_id,
    itemId: row.item_id,
    itemNumber: row.items?.item_number ?? '',
    description: row.items?.description ?? '',
    unit: row.items?.unit ?? '',
    itemKind: row.items?.item_kind ?? 'unit_price',
    claimedQuantity: row.claimed_quantity === null ? null : Number(row.claimed_quantity),
    certifiedQuantity: row.certified_quantity === null ? null : Number(row.certified_quantity),
    claimedPercent: row.claimed_percent === null ? null : Number(row.claimed_percent),
    certifiedPercent: row.certified_percent === null ? null : Number(row.certified_percent),
    claimedValue: row.claimed_value === null ? null : Number(row.claimed_value),
    certifiedValue: row.certified_value === null ? null : Number(row.certified_value),
    paidAmount: row.paid_amount === null ? null : Number(row.paid_amount),
    disputed: row.disputed,
    varianceNote: row.variance_note,
  }
}

/** Every line on one progress estimate, Item order not guaranteed by the server — callers that need a stable order (the detail screen) sort client-side by itemNumber, same convention as fetchItems. */
export async function fetchProgressEstimateItems(progressEstimateId: string): Promise<ProgressEstimateItem[]> {
  const { data, error } = await supabase.from('progress_estimate_items').select(ESTIMATE_ITEM_SELECT).eq('progress_estimate_id', progressEstimateId)
  if (error) throw error
  return (data ?? []).map((row) => mapEstimateItemRow(row as unknown as RawProgressEstimateItemRow))
}

/**
 * Creates the header row, then inserts one line per proposed claim — the
 * "propose from records" action (progressEstimates.ts calc's
 * proposeClaimedFromRecords supplies the claims). Two statements, not one
 * transaction: Supabase's client has no cross-table transaction primitive,
 * and a header with zero lines (a period with no unit_price activity at
 * all) is a legitimate, not a broken, outcome — the lines can still be
 * added by hand afterward. Returns the header; callers refetch items via
 * fetchProgressEstimateItems.
 */
export async function createProgressEstimate(
  contractId: string,
  input: { periodStart: string; periodEnd: string; ministryReference?: string | null; note?: string | null },
  claims: readonly { itemId: string; claimedQuantity: number; claimedValue: number | null }[],
): Promise<ProgressEstimate> {
  const { data, error } = await supabase
    .from('progress_estimates')
    .insert({
      contract_id: contractId,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      ministry_reference: input.ministryReference ?? null,
      note: input.note ?? null,
    })
    .select(ESTIMATE_SELECT)
    .single()
  if (error) throw error
  const estimate = mapEstimateRow(data as unknown as RawProgressEstimateRow)

  if (claims.length > 0) {
    const { error: itemsError } = await supabase.from('progress_estimate_items').insert(
      claims.map((claim) => ({
        progress_estimate_id: estimate.id,
        item_id: claim.itemId,
        contract_id: contractId,
        claimed_quantity: claim.claimedQuantity,
        claimed_value: claim.claimedValue,
      })),
    )
    if (itemsError) throw itemsError
  }

  return estimate
}

/** draft -> submitted -> received -> reconciled, or any other transition RLS/the check constraint allows — this function doesn't enforce a sequence itself, matching updateContractState's own pattern of trusting the caller's UI to only offer valid next steps. Logged automatically by progress_estimate_status_history. */
export async function updateProgressEstimateStatus(id: string, status: ProgressEstimateStatus): Promise<void> {
  const { error } = await supabase.from('progress_estimates').update({ status }).eq('id', id)
  if (error) throw error
}

/**
 * Add a line to an existing estimate by hand — the path for Lump Sum and
 * Provisional Sum Items, which proposeClaimedFromRecords never proposes
 * (see that function's own doc comment), and for a unit_price Item the
 * automatic proposal missed. Claimed figures only; certified_* stays null
 * until the Ministry's figures arrive via updateProgressEstimateItemCertified.
 */
export async function addProgressEstimateItem(input: {
  progressEstimateId: string
  itemId: string
  contractId: string
  claimedQuantity?: number | null
  claimedPercent?: number | null
  claimedValue?: number | null
}): Promise<ProgressEstimateItem> {
  const { data, error } = await supabase
    .from('progress_estimate_items')
    .insert({
      progress_estimate_id: input.progressEstimateId,
      item_id: input.itemId,
      contract_id: input.contractId,
      claimed_quantity: input.claimedQuantity ?? null,
      claimed_percent: input.claimedPercent ?? null,
      claimed_value: input.claimedValue ?? null,
    })
    .select(ESTIMATE_ITEM_SELECT)
    .single()
  if (error) throw error
  return mapEstimateItemRow(data as unknown as RawProgressEstimateItemRow)
}

/** Frozen once the parent estimate leaves draft (guard_progress_estimate_claim, 0041) — the database rejects this past that point, this function doesn't pre-check status itself. */
export async function updateProgressEstimateItemClaim(id: string, input: { claimedQuantity?: number | null; claimedPercent?: number | null; claimedValue?: number | null }): Promise<void> {
  const patch: Record<string, number | null> = {}
  if ('claimedQuantity' in input) patch.claimed_quantity = input.claimedQuantity ?? null
  if ('claimedPercent' in input) patch.claimed_percent = input.claimedPercent ?? null
  if ('claimedValue' in input) patch.claimed_value = input.claimedValue ?? null
  const { error } = await supabase.from('progress_estimate_items').update(patch).eq('id', id)
  if (error) throw error
}

/** The Ministry's own figures — never derived, entered exactly as the certificate states them. Writable regardless of the parent estimate's status (unlike claimed_*): a correction to an already-received certificate is the normal case, not an edge case, and progress_estimate_items_history logs every real change. */
export async function updateProgressEstimateItemCertified(
  id: string,
  input: { certifiedQuantity?: number | null; certifiedPercent?: number | null; certifiedValue?: number | null; paidAmount?: number | null },
): Promise<void> {
  const patch: Record<string, number | null> = {}
  if ('certifiedQuantity' in input) patch.certified_quantity = input.certifiedQuantity ?? null
  if ('certifiedPercent' in input) patch.certified_percent = input.certifiedPercent ?? null
  if ('certifiedValue' in input) patch.certified_value = input.certifiedValue ?? null
  if ('paidAmount' in input) patch.paid_amount = input.paidAmount ?? null
  const { error } = await supabase.from('progress_estimate_items').update(patch).eq('id', id)
  if (error) throw error
}

/** disputed is a flag on a line and nothing more — no history, no workflow beyond it and the note beside it. */
export async function updateProgressEstimateItemDispute(id: string, input: { disputed: boolean; varianceNote: string | null }): Promise<void> {
  const { error } = await supabase.from('progress_estimate_items').update({ disputed: input.disputed, variance_note: input.varianceNote }).eq('id', id)
  if (error) throw error
}
