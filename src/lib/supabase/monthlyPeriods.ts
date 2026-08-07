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

/**
 * Contract-level monthly value/cost/margin (0013's v_contract_month) —
 * behind the finance wall by construction (joins item_prices, gated on
 * view_rates); a seat without it gets zero rows, not an error.
 * cost/margin are genuinely nullable independent of value: a month can have
 * real recorded quantity (value_in_period a real number) while cost
 * coverage that month is incomplete or absent, which the view itself
 * reports as a SQL NULL, not a zero — Keywest simply doesn't know that
 * figure yet.
 */
export interface ContractMonth {
  contractId: string
  periodMonth: string
  itemsWorked: number
  valueInPeriod: number | null
  costInPeriod: number | null
  marginInPeriod: number | null
  workingDays: number
}

interface RawContractMonthRow {
  contract_id: string
  period_month: string
  items_worked: number
  value_in_period: string | null
  cost_in_period: string | null
  margin_in_period: string | null
  working_days: number
}

function nullableNumber(v: string | null): number | null {
  return v === null ? null : Number(v)
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
      // `Number(null)` is 0, not NaN — a plain Number() cast here would
      // silently turn "cost not fully priced this month" into a real $0.00,
      // the exact absent/zero conflation this app works hard to avoid
      // everywhere else (sumOrNull, rowFinancials' own null-propagation).
      valueInPeriod: nullableNumber(r.value_in_period),
      costInPeriod: nullableNumber(r.cost_in_period),
      marginInPeriod: nullableNumber(r.margin_in_period),
      workingDays: r.working_days,
    }
  })
}

/**
 * Rate-of-progress per unit_price Item (0013's v_item_progress_rate).
 * Carries no money and needs no view_rates.
 *
 * workingDaysRemaining IS a projection — a linear extrapolation of
 * quantityRemaining over the last-30-days rate — despite this view's own
 * age predating that being named plainly. It is deliberately not rendered
 * anywhere as of the production-rate brief: ProblemRow.tsx's "behind rate"
 * sentence states quantityLast30/workingDaysLast30/quantityRemaining
 * instead, the observable facts the projection was computed from, not the
 * projection itself. workingDaysRemaining stays computed here (and
 * classifyProblem in overview.ts still uses it as a trigger) so the
 * column doesn't need a schema change to stop being surfaced — see that
 * brief's report for the full list of who reads this view and why.
 *
 * quantityPerWorkingDay is dead in every production consumer as of the
 * same brief — computed here, read nowhere but overview.test.ts's fixture
 * data. Left in place pending a decision on the view as a whole, not
 * removed piecemeal.
 */
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

/**
 * Every field on `v_item_progress` — unlike `v_item_progress_rate` above
 * (built on top of it, but only for the "needs attention" rate math), this
 * carries `percentComplete`/`provisionalSum`/`authorizedValue`, which the
 * Tracker needs for Lump Sum and Provisional Sum Items (neither has a
 * meaningful quantity). No `view_rates` gate — the view carries no money,
 * same as `v_item_progress_rate`.
 */
export interface ItemProgress {
  itemId: string
  contractId: string
  itemNumber: string
  description: string
  unit: string
  itemKind: ItemKind
  approximateQuantity: number
  percentComplete: number | null
  provisionalSum: number | null
  authorizedValue: number | null
  quantityToDate: number
  proportionComplete: number | null
  recordCount: number
  lastWorkDate: string | null
}

interface RawItemProgressRow {
  item_id: string
  contract_id: string
  item_number: string
  description: string
  unit: string
  item_kind: ItemKind
  approximate_quantity: string
  percent_complete: string | null
  provisional_sum: string | null
  authorized_value: string | null
  quantity_to_date: string
  proportion_complete: string | null
  record_count: number
  last_work_date: string | null
}

export async function fetchItemProgress(contractId: string): Promise<ItemProgress[]> {
  const { data, error } = await supabase
    .from('v_item_progress')
    .select(
      'item_id, contract_id, item_number, description, unit, item_kind, approximate_quantity, percent_complete, provisional_sum, authorized_value, quantity_to_date, proportion_complete, record_count, last_work_date',
    )
    .eq('contract_id', contractId)
  if (error) throw error
  return (data ?? []).map((row) => {
    const r = row as unknown as RawItemProgressRow
    return {
      itemId: r.item_id,
      contractId: r.contract_id,
      itemNumber: r.item_number,
      description: r.description,
      unit: r.unit,
      itemKind: r.item_kind,
      approximateQuantity: Number(r.approximate_quantity),
      percentComplete: r.percent_complete === null ? null : Number(r.percent_complete),
      provisionalSum: r.provisional_sum === null ? null : Number(r.provisional_sum),
      authorizedValue: r.authorized_value === null ? null : Number(r.authorized_value),
      quantityToDate: Number(r.quantity_to_date),
      proportionComplete: r.proportion_complete === null ? null : Number(r.proportion_complete),
      recordCount: r.record_count,
      lastWorkDate: r.last_work_date,
    }
  })
}
