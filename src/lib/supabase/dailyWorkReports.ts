import { supabase } from './client'
import type { DwrBlock, ForceAccountTerms, SubFlag } from '../calculations/dwrCalculations'

// ---------------------------------------------------------------------------
// Daily Work Reports (Force Account claims, GC 49.00). Header is mutable
// until certified (certify_daily_work_report RPC), then locked — see
// 20260816160000's header for why this departs from quantity_records/
// actual_cost_entries' append-only shape. Block subtotals/markups are never
// stored; resolve them from fetchDwrLineItems() + fetchForceAccountTerms()
// via dwrCalculations.ts and rateHistory.ts's asOfDate(work_date) — never
// today's date.
// ---------------------------------------------------------------------------

export interface DailyWorkReport {
  id: string
  contractId: string
  dwrNumber: number
  itemId: string | null
  forceAccountNumber: string | null
  psItemNumber: string | null
  workDate: string
  descriptionOfWork: string
  gcVersionDate: string
  reducedMarkups: boolean
  certifiedBy: string | null
  certifiedAt: string | null
  ministryTrackingAcceptedBy: string | null
  ministryTrackingAcceptedAt: string | null
  ministryPaymentAcceptedBy: string | null
  ministryPaymentAcceptedAt: string | null
  createdBy: string
  createdAt: string
}

interface RawDwrRow {
  id: string
  contract_id: string
  dwr_number: number
  item_id: string | null
  force_account_number: string | null
  ps_item_number: string | null
  work_date: string
  description_of_work: string
  gc_version_date: string
  reduced_markups: boolean
  certified_by: string | null
  certified_at: string | null
  ministry_tracking_accepted_by: string | null
  ministry_tracking_accepted_at: string | null
  ministry_payment_accepted_by: string | null
  ministry_payment_accepted_at: string | null
  created_by: string
  created_at: string
}

function mapDwrRow(row: RawDwrRow): DailyWorkReport {
  return {
    id: row.id,
    contractId: row.contract_id,
    dwrNumber: row.dwr_number,
    itemId: row.item_id,
    forceAccountNumber: row.force_account_number,
    psItemNumber: row.ps_item_number,
    workDate: row.work_date,
    descriptionOfWork: row.description_of_work,
    gcVersionDate: row.gc_version_date,
    reducedMarkups: row.reduced_markups,
    certifiedBy: row.certified_by,
    certifiedAt: row.certified_at,
    ministryTrackingAcceptedBy: row.ministry_tracking_accepted_by,
    ministryTrackingAcceptedAt: row.ministry_tracking_accepted_at,
    ministryPaymentAcceptedBy: row.ministry_payment_accepted_by,
    ministryPaymentAcceptedAt: row.ministry_payment_accepted_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

const DWR_SELECT =
  'id, contract_id, dwr_number, item_id, force_account_number, ps_item_number, work_date, description_of_work, gc_version_date, reduced_markups, ' +
  'certified_by, certified_at, ministry_tracking_accepted_by, ministry_tracking_accepted_at, ministry_payment_accepted_by, ministry_payment_accepted_at, ' +
  'created_by, created_at'

export async function fetchDailyWorkReports(contractId: string): Promise<DailyWorkReport[]> {
  const { data, error } = await supabase.from('daily_work_reports').select(DWR_SELECT).eq('contract_id', contractId).order('work_date', { ascending: false })
  if (error) throw error
  return (data ?? []).map((row) => mapDwrRow(row as unknown as RawDwrRow))
}

export async function fetchDailyWorkReport(id: string): Promise<DailyWorkReport | null> {
  const { data, error } = await supabase.from('daily_work_reports').select(DWR_SELECT).eq('id', id).maybeSingle()
  if (error) throw error
  return data ? mapDwrRow(data as unknown as RawDwrRow) : null
}

export interface DailyWorkReportInput {
  itemId: string | null
  forceAccountNumber: string | null
  psItemNumber: string | null
  workDate: string
  descriptionOfWork: string
  gcVersionDate: string
  reducedMarkups: boolean
}

export async function createDailyWorkReport(contractId: string, input: DailyWorkReportInput): Promise<DailyWorkReport> {
  const { data, error } = await supabase
    .from('daily_work_reports')
    .insert({
      contract_id: contractId,
      item_id: input.itemId,
      force_account_number: input.forceAccountNumber,
      ps_item_number: input.psItemNumber,
      work_date: input.workDate,
      description_of_work: input.descriptionOfWork,
      gc_version_date: input.gcVersionDate,
      reduced_markups: input.reducedMarkups,
    })
    .select(DWR_SELECT)
    .single()
  if (error) throw error
  return mapDwrRow(data as unknown as RawDwrRow)
}

/** Every field here stays editable regardless of certification EXCEPT the four the certified-lock trigger guards (workDate/descriptionOfWork/gcVersionDate/reducedMarkups) — a write to those on a certified DWR is rejected by the database, not by this function; the trigger's error message is what the caller sees. */
export async function updateDailyWorkReport(id: string, input: Partial<DailyWorkReportInput>): Promise<DailyWorkReport> {
  const patch: Record<string, unknown> = {}
  if (input.itemId !== undefined) patch.item_id = input.itemId
  if (input.forceAccountNumber !== undefined) patch.force_account_number = input.forceAccountNumber
  if (input.psItemNumber !== undefined) patch.ps_item_number = input.psItemNumber
  if (input.workDate !== undefined) patch.work_date = input.workDate
  if (input.descriptionOfWork !== undefined) patch.description_of_work = input.descriptionOfWork
  if (input.gcVersionDate !== undefined) patch.gc_version_date = input.gcVersionDate
  if (input.reducedMarkups !== undefined) patch.reduced_markups = input.reducedMarkups
  const { data, error } = await supabase.from('daily_work_reports').update(patch).eq('id', id).select(DWR_SELECT).single()
  if (error) throw error
  return mapDwrRow(data as unknown as RawDwrRow)
}

export interface MinistryAcceptanceInput {
  ministryTrackingAcceptedBy?: string | null
  ministryTrackingAcceptedAt?: string | null
  ministryPaymentAcceptedBy?: string | null
  ministryPaymentAcceptedAt?: string | null
}

/** Recorded after the fact, off a returned signed copy — not gated by certification status, see the migration's own header. */
export async function recordMinistryAcceptance(id: string, input: MinistryAcceptanceInput): Promise<DailyWorkReport> {
  const patch: Record<string, unknown> = {}
  if (input.ministryTrackingAcceptedBy !== undefined) patch.ministry_tracking_accepted_by = input.ministryTrackingAcceptedBy
  if (input.ministryTrackingAcceptedAt !== undefined) patch.ministry_tracking_accepted_at = input.ministryTrackingAcceptedAt
  if (input.ministryPaymentAcceptedBy !== undefined) patch.ministry_payment_accepted_by = input.ministryPaymentAcceptedBy
  if (input.ministryPaymentAcceptedAt !== undefined) patch.ministry_payment_accepted_at = input.ministryPaymentAcceptedAt
  const { data, error } = await supabase.from('daily_work_reports').update(patch).eq('id', id).select(DWR_SELECT).single()
  if (error) throw error
  return mapDwrRow(data as unknown as RawDwrRow)
}

/** The only door to certified_at/certified_by — no plain UPDATE grant exists on either column. Locks work_date/description_of_work/gc_version_date/reduced_markups and every line item/subcontractor row. Throws with a message prefixed 'already-certified:', 'not-permitted:', or 'not-found:' — greppable, per confirm_quantity_record's own convention. */
export async function certifyDailyWorkReport(id: string): Promise<DailyWorkReport> {
  const { data, error } = await supabase.rpc('certify_daily_work_report', { p_id: id })
  if (error) throw error
  return mapDwrRow(data as unknown as RawDwrRow)
}

/** The explicit, audited way back to draft — a DWR is a document annotated over its life, not an append-only ledger. Throws prefixed 'not-certified:', 'not-permitted:', or 'not-found:'. */
export async function reopenDailyWorkReport(id: string): Promise<DailyWorkReport> {
  const { data, error } = await supabase.rpc('reopen_daily_work_report', { p_id: id })
  if (error) throw error
  return mapDwrRow(data as unknown as RawDwrRow)
}

// ---------------------------------------------------------------------------
// Subcontractors — a plain name list, no rate data, no view_cost_register_
// rates requirement.
// ---------------------------------------------------------------------------

export interface DwrSubcontractor {
  id: string
  dwrId: string
  name: string
}

interface RawSubcontractorRow {
  id: string
  dwr_id: string
  name: string
}

function mapSubcontractorRow(row: RawSubcontractorRow): DwrSubcontractor {
  return { id: row.id, dwrId: row.dwr_id, name: row.name }
}

const SUBCONTRACTOR_SELECT = 'id, dwr_id, name'

export async function fetchDwrSubcontractors(dwrId: string): Promise<DwrSubcontractor[]> {
  const { data, error } = await supabase.from('daily_work_report_subcontractors').select(SUBCONTRACTOR_SELECT).eq('dwr_id', dwrId).order('name')
  if (error) throw error
  return (data ?? []).map((row) => mapSubcontractorRow(row as unknown as RawSubcontractorRow))
}

/** Every subcontractor named on any DWR on the contract — needed to resolve names for the cross-DWR subcontractor cap summary, which spans line items from DWRs other than the one currently open. */
export async function fetchContractDwrSubcontractors(contractId: string): Promise<DwrSubcontractor[]> {
  const { data, error } = await supabase.from('daily_work_report_subcontractors').select(SUBCONTRACTOR_SELECT).eq('contract_id', contractId)
  if (error) throw error
  return (data ?? []).map((row) => mapSubcontractorRow(row as unknown as RawSubcontractorRow))
}

export async function createDwrSubcontractor(dwrId: string, contractId: string, name: string): Promise<DwrSubcontractor> {
  const { data, error } = await supabase
    .from('daily_work_report_subcontractors')
    .insert({ dwr_id: dwrId, contract_id: contractId, name })
    .select(SUBCONTRACTOR_SELECT)
    .single()
  if (error) throw error
  return mapSubcontractorRow(data as unknown as RawSubcontractorRow)
}

export async function deleteDwrSubcontractor(id: string): Promise<void> {
  const { error } = await supabase.from('daily_work_report_subcontractors').delete().eq('id', id)
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Line items — one polymorphic table, all six blocks. Write requires BOTH
// record_force_account AND view_cost_register_rates/maintain_cost_registers
// (RLS, 20260816170000) — a line's rate is a register rate.
// ---------------------------------------------------------------------------

export interface DailyWorkReportLineItem {
  id: string
  dwrId: string
  block: DwrBlock
  subFlag: SubFlag
  subcontractorId: string | null
  descriptor: string
  secondaryDescriptor: string | null
  quantity: number
  rate: number
  amount: number
  equipmentId: string | null
  labourClassId: string | null
  materialId: string | null
}

interface RawLineItemRow {
  id: string
  dwr_id: string
  block: DwrBlock
  sub_flag: SubFlag
  subcontractor_id: string | null
  descriptor: string
  secondary_descriptor: string | null
  quantity: string
  rate: string
  amount: string
  equipment_id: string | null
  labour_class_id: string | null
  material_id: string | null
}

function mapLineItemRow(row: RawLineItemRow): DailyWorkReportLineItem {
  return {
    id: row.id,
    dwrId: row.dwr_id,
    block: row.block,
    subFlag: row.sub_flag,
    subcontractorId: row.subcontractor_id,
    descriptor: row.descriptor,
    secondaryDescriptor: row.secondary_descriptor,
    quantity: Number(row.quantity),
    rate: Number(row.rate),
    amount: Number(row.amount),
    equipmentId: row.equipment_id,
    labourClassId: row.labour_class_id,
    materialId: row.material_id,
  }
}

const LINE_ITEM_SELECT =
  'id, dwr_id, block, sub_flag, subcontractor_id, descriptor, secondary_descriptor, quantity, rate, amount, equipment_id, labour_class_id, material_id'

export async function fetchDwrLineItems(dwrId: string): Promise<DailyWorkReportLineItem[]> {
  const { data, error } = await supabase.from('daily_work_report_line_items').select(LINE_ITEM_SELECT).eq('dwr_id', dwrId).order('block')
  if (error) throw error
  return (data ?? []).map((row) => mapLineItemRow(row as unknown as RawLineItemRow))
}

/** Every line item across every DWR on the contract, in one query (line items carry contract_id directly — no per-DWR fetch loop needed) — the raw material for the 25%-of-Tender-Price cumulative check, grouped by dwr_id by the caller. */
export async function fetchContractDwrLineItems(contractId: string): Promise<(DailyWorkReportLineItem & { dwrId: string })[]> {
  const { data, error } = await supabase
    .from('daily_work_report_line_items')
    .select(`${LINE_ITEM_SELECT}`)
    .eq('contract_id', contractId)
  if (error) throw error
  return (data ?? []).map((row) => mapLineItemRow(row as unknown as RawLineItemRow))
}

export interface DwrLineItemInput {
  block: DwrBlock
  subFlag: SubFlag
  subcontractorId: string | null
  descriptor: string
  secondaryDescriptor: string | null
  quantity: number
  rate: number
  amount: number
  equipmentId: string | null
  labourClassId: string | null
  materialId: string | null
}

export async function createDwrLineItem(dwrId: string, contractId: string, input: DwrLineItemInput): Promise<DailyWorkReportLineItem> {
  const { data, error } = await supabase
    .from('daily_work_report_line_items')
    .insert({
      dwr_id: dwrId,
      contract_id: contractId,
      block: input.block,
      sub_flag: input.subFlag,
      subcontractor_id: input.subcontractorId,
      descriptor: input.descriptor,
      secondary_descriptor: input.secondaryDescriptor,
      quantity: input.quantity,
      rate: input.rate,
      amount: input.amount,
      equipment_id: input.equipmentId,
      labour_class_id: input.labourClassId,
      material_id: input.materialId,
    })
    .select(LINE_ITEM_SELECT)
    .single()
  if (error) throw error
  return mapLineItemRow(data as unknown as RawLineItemRow)
}

export async function updateDwrLineItem(id: string, input: DwrLineItemInput): Promise<DailyWorkReportLineItem> {
  const { data, error } = await supabase
    .from('daily_work_report_line_items')
    .update({
      block: input.block,
      sub_flag: input.subFlag,
      subcontractor_id: input.subcontractorId,
      descriptor: input.descriptor,
      secondary_descriptor: input.secondaryDescriptor,
      quantity: input.quantity,
      rate: input.rate,
      amount: input.amount,
      equipment_id: input.equipmentId,
      labour_class_id: input.labourClassId,
      material_id: input.materialId,
    })
    .eq('id', id)
    .select(LINE_ITEM_SELECT)
    .single()
  if (error) throw error
  return mapLineItemRow(data as unknown as RawLineItemRow)
}

export async function deleteDwrLineItem(id: string): Promise<void> {
  const { error } = await supabase.from('daily_work_report_line_items').delete().eq('id', id)
  if (error) throw error
}

// ---------------------------------------------------------------------------
// contract_force_account_terms — edition-keyed per contract. Resolve with
// asOfDate(rows, dwr.workDate) from rateHistory.ts, never currentByDate.
// ---------------------------------------------------------------------------

export interface ContractForceAccountTerms extends ForceAccountTerms {
  id: string
  contractId: string
}

interface RawTermsRow {
  id: string
  contract_id: string
  effective_date: string
  gc_version_date: string
  labour_basic_pct: string
  labour_reduced_pct: string
  equipment_basic_pct: string
  equipment_reduced_pct: string
  materials_basic_pct: string
  materials_reduced_pct: string
  prep_basic_pct: string
  prep_reduced_pct: string
  food_basic_pct: string
  food_reduced_pct: string
  subcontractor_markup_pct: string
  reduced_threshold_pct: string
  subcontractor_cap_amount: string
}

function mapTermsRow(row: RawTermsRow): ContractForceAccountTerms {
  return {
    id: row.id,
    contractId: row.contract_id,
    effectiveDate: row.effective_date,
    gcVersionDate: row.gc_version_date,
    labourBasicPct: Number(row.labour_basic_pct),
    labourReducedPct: Number(row.labour_reduced_pct),
    equipmentBasicPct: Number(row.equipment_basic_pct),
    equipmentReducedPct: Number(row.equipment_reduced_pct),
    materialsBasicPct: Number(row.materials_basic_pct),
    materialsReducedPct: Number(row.materials_reduced_pct),
    prepBasicPct: Number(row.prep_basic_pct),
    prepReducedPct: Number(row.prep_reduced_pct),
    foodBasicPct: Number(row.food_basic_pct),
    foodReducedPct: Number(row.food_reduced_pct),
    subcontractorMarkupPct: Number(row.subcontractor_markup_pct),
    reducedThresholdPct: Number(row.reduced_threshold_pct),
    subcontractorCapAmount: Number(row.subcontractor_cap_amount),
  }
}

const TERMS_SELECT =
  'id, contract_id, effective_date, gc_version_date, labour_basic_pct, labour_reduced_pct, equipment_basic_pct, equipment_reduced_pct, ' +
  'materials_basic_pct, materials_reduced_pct, prep_basic_pct, prep_reduced_pct, food_basic_pct, food_reduced_pct, subcontractor_markup_pct, ' +
  'reduced_threshold_pct, subcontractor_cap_amount'

export async function fetchContractForceAccountTerms(contractId: string): Promise<ContractForceAccountTerms[]> {
  const { data, error } = await supabase.from('contract_force_account_terms').select(TERMS_SELECT).eq('contract_id', contractId)
  if (error) throw error
  return (data ?? []).map((row) => mapTermsRow(row as unknown as RawTermsRow))
}

export type ContractForceAccountTermsInput = Omit<ForceAccountTerms, 'reducedThresholdPct' | 'subcontractorCapAmount'> &
  Partial<Pick<ForceAccountTerms, 'reducedThresholdPct' | 'subcontractorCapAmount'>>

/** Upsert on (contract_id, effective_date) — the same edition corrected in place, a new edition always a new row, same pattern as labour_class_rates. */
export async function upsertContractForceAccountTerms(contractId: string, input: ContractForceAccountTermsInput): Promise<ContractForceAccountTerms> {
  const { data, error } = await supabase
    .from('contract_force_account_terms')
    .upsert(
      {
        contract_id: contractId,
        effective_date: input.effectiveDate,
        gc_version_date: input.gcVersionDate,
        labour_basic_pct: input.labourBasicPct,
        labour_reduced_pct: input.labourReducedPct,
        equipment_basic_pct: input.equipmentBasicPct,
        equipment_reduced_pct: input.equipmentReducedPct,
        materials_basic_pct: input.materialsBasicPct,
        materials_reduced_pct: input.materialsReducedPct,
        prep_basic_pct: input.prepBasicPct,
        prep_reduced_pct: input.prepReducedPct,
        food_basic_pct: input.foodBasicPct,
        food_reduced_pct: input.foodReducedPct,
        subcontractor_markup_pct: input.subcontractorMarkupPct,
        ...(input.reducedThresholdPct !== undefined ? { reduced_threshold_pct: input.reducedThresholdPct } : {}),
        ...(input.subcontractorCapAmount !== undefined ? { subcontractor_cap_amount: input.subcontractorCapAmount } : {}),
      },
      { onConflict: 'contract_id,effective_date' },
    )
    .select(TERMS_SELECT)
    .single()
  if (error) throw error
  return mapTermsRow(data as unknown as RawTermsRow)
}
