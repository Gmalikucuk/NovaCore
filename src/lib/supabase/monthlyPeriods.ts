import { supabase } from './client'
import type { ItemKind } from './items'

/** Per Item, per calendar month — quantity only, no money (0013's v_item_month). Readable by any contract member regardless of view_rates. */
export interface ItemMonth {
  contractId: string
  itemId: string
  periodMonth: string // 'YYYY-MM-DD', always the 1st
  quantityInPeriod: number
  recordCount: number
  firstWorkDate: string
  lastWorkDate: string
  workingDays: number
}

interface RawItemMonthRow {
  contract_id: string
  item_id: string
  period_month: string
  quantity_in_period: string
  record_count: number
  first_work_date: string
  last_work_date: string
  working_days: number
}

/** Every month's quantity for every Item on the contract — small enough (one row per item per month worked) to fetch whole and filter client-side when the Overview's month selector changes, rather than a round-trip per month. */
export async function fetchItemMonths(contractId: string): Promise<ItemMonth[]> {
  const { data, error } = await supabase
    .from('v_item_month')
    .select('contract_id, item_id, period_month, quantity_in_period, record_count, first_work_date, last_work_date, working_days')
    .eq('contract_id', contractId)
  if (error) throw error
  return (data ?? []).map((row) => {
    const r = row as unknown as RawItemMonthRow
    return {
      contractId: r.contract_id,
      itemId: r.item_id,
      periodMonth: r.period_month,
      quantityInPeriod: Number(r.quantity_in_period),
      recordCount: r.record_count,
      firstWorkDate: r.first_work_date,
      lastWorkDate: r.last_work_date,
      workingDays: r.working_days,
    }
  })
}

/** Contract-level monthly value/cost/margin (0013's v_contract_month) — behind the finance wall by construction (joins item_prices, gated on view_rates); a seat without it gets zero rows, not an error. */
export interface ContractMonth {
  contractId: string
  periodMonth: string
  itemsWorked: number
  valueInPeriod: number
  costInPeriod: number
  marginInPeriod: number
  workingDays: number
}

interface RawContractMonthRow {
  contract_id: string
  period_month: string
  items_worked: number
  value_in_period: string
  cost_in_period: string
  margin_in_period: string
  working_days: number
}

export async function fetchContractMonths(contractId: string): Promise<ContractMonth[]> {
  const { data, error } = await supabase
    .from('v_contract_month')
    .select('contract_id, period_month, items_worked, value_in_period, cost_in_period, margin_in_period, working_days')
    .eq('contract_id', contractId)
  if (error) throw error
  return (data ?? []).map((row) => {
    const r = row as unknown as RawContractMonthRow
    return {
      contractId: r.contract_id,
      periodMonth: r.period_month,
      itemsWorked: r.items_worked,
      valueInPeriod: Number(r.value_in_period),
      costInPeriod: Number(r.cost_in_period),
      marginInPeriod: Number(r.margin_in_period),
      workingDays: r.working_days,
    }
  })
}

/** Rate-of-progress per unit_price Item (0013's v_item_progress_rate) — an early-warning indicator, not a forecast (linear projection from the last 30 days over days actually worked). Carries no money and needs no view_rates. */
export interface ItemProgressRate {
  itemId: string
  contractId: string
  itemNumber: string
  description: string
  unit: string
  itemKind: ItemKind
  approximateQuantity: number
  quantityToDate: number
  proportionComplete: number | null
  quantityRemaining: number
  quantityLast30: number
  workingDaysLast30: number | null
  lastWorkDate: string | null
  quantityPerWorkingDay: number | null
  workingDaysRemaining: number | null
  isStalled: boolean
  isOverQuantity: boolean
}

interface RawItemProgressRateRow {
  item_id: string
  contract_id: string
  item_number: string
  description: string
  unit: string
  item_kind: ItemKind
  approximate_quantity: string
  quantity_to_date: string
  proportion_complete: string | null
  quantity_remaining: string
  quantity_last_30: string
  working_days_last_30: number | null
  last_work_date: string | null
  quantity_per_working_day: string | null
  working_days_remaining: number | null
  is_stalled: boolean
  is_over_quantity: boolean
}

export async function fetchItemProgressRate(contractId: string): Promise<ItemProgressRate[]> {
  const { data, error } = await supabase
    .from('v_item_progress_rate')
    .select(
      'item_id, contract_id, item_number, description, unit, item_kind, approximate_quantity, quantity_to_date, proportion_complete, quantity_remaining, quantity_last_30, working_days_last_30, last_work_date, quantity_per_working_day, working_days_remaining, is_stalled, is_over_quantity',
    )
    .eq('contract_id', contractId)
  if (error) throw error
  return (data ?? []).map((row) => {
    const r = row as unknown as RawItemProgressRateRow
    return {
      itemId: r.item_id,
      contractId: r.contract_id,
      itemNumber: r.item_number,
      description: r.description,
      unit: r.unit,
      itemKind: r.item_kind,
      approximateQuantity: Number(r.approximate_quantity),
      quantityToDate: Number(r.quantity_to_date),
      proportionComplete: r.proportion_complete === null ? null : Number(r.proportion_complete),
      quantityRemaining: Number(r.quantity_remaining),
      quantityLast30: Number(r.quantity_last_30),
      workingDaysLast30: r.working_days_last_30,
      lastWorkDate: r.last_work_date,
      quantityPerWorkingDay: r.quantity_per_working_day === null ? null : Number(r.quantity_per_working_day),
      workingDaysRemaining: r.working_days_remaining,
      isStalled: r.is_stalled,
      isOverQuantity: r.is_over_quantity,
    }
  })
}
