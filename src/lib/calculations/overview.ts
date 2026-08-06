import type { ContractState } from '../supabase/contracts'
import type { Item } from '../supabase/items'
import type { ItemProgressRate } from '../supabase/monthlyPeriods'
import type { ItemPrice } from '../supabase/prices'
import { rowFinancials } from './bidSummary'
import { sumOrNull } from './margin'

// ─────────────────────────────────────────────────────────────────────────
// Month arithmetic — plain {year, month} integers, never routed through a
// Date object for the rollover itself (December -> January across a year
// boundary is exactly where local-timezone Date math silently drifts a
// day). Date is only used at the edges, to format a label — never to
// compute what "previous month" means.
// ─────────────────────────────────────────────────────────────────────────

export interface MonthKey {
  year: number
  month: number // 1-12
}

export function monthKeyFromDate(date: Date): MonthKey {
  return { year: date.getFullYear(), month: date.getMonth() + 1 }
}

export function previousMonth(k: MonthKey): MonthKey {
  return k.month === 1 ? { year: k.year - 1, month: 12 } : { year: k.year, month: k.month - 1 }
}

/** Matches v_item_month/v_contract_month's period_month exactly — date_trunc('month', work_date), always the 1st. */
export function monthKeyToPeriod(k: MonthKey): string {
  return `${k.year}-${String(k.month).padStart(2, '0')}-01`
}

export function formatMonthLabel(k: MonthKey): string {
  return new Date(k.year, k.month - 1, 1).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })
}

/** Started but not yet finished — Band 1's other headline figure. Same rows (progressRate, already unit_price-only). */
export function itemsInProgress(rows: readonly { quantityToDate: number; approximateQuantity: number }[]): { started: number; total: number } {
  const started = rows.filter((r) => r.quantityToDate > 0 && r.quantityToDate < r.approximateQuantity).length
  return { started, total: rows.length }
}

// ─────────────────────────────────────────────────────────────────────────
// Month-over-month direction — for Band 1's "beside it, with the direction
// of change" figures.
// ─────────────────────────────────────────────────────────────────────────

export type Direction = 'up' | 'down' | 'flat'

export function monthDirection(current: number, previous: number): Direction {
  if (current > previous) return 'up'
  if (current < previous) return 'down'
  return 'flat'
}

// ─────────────────────────────────────────────────────────────────────────
// Band 2's problem list. Three kinds, ranked by consequence rather than by
// type — over quantity (cost exposure, largest overage first), then behind
// rate, then stalled (schedule risk, longest idle last) — each its own
// group, worst first within it. The three conditions are near-mutually-
// exclusive by the view's own math (is_over_quantity implies
// quantity_remaining = 0, which makes working_days_remaining null; a
// genuinely stalled item usually has no quantity_last_30 either, which does
// the same) — classifyProblem still checks stalled first internally for the
// rare item where more than one could technically hold, since a stalled
// item's other numbers are the least meaningful of the three.
//
// "Behind rate" has no season-end date anywhere in the schema (checked:
// contracts has no such column) to compare working_days_remaining against,
// so there is no literal way to compute "will not finish in the season."
// BEHIND_RATE_THRESHOLD_DAYS is a stated, visible-in-the-UI stand-in — six
// working weeks of remaining work at the observed rate is a real problem on
// any contract's timeline, not a threshold tuned to a specific season. This
// is the piece of the brief most likely to need a real value once a season
// boundary exists per contract — flagged in the handoff report.
// ─────────────────────────────────────────────────────────────────────────

export const BEHIND_RATE_THRESHOLD_DAYS = 30

export type ProblemKind = 'stalled' | 'over_quantity' | 'behind_rate'

export interface ProblemItem {
  kind: ProblemKind
  row: ItemProgressRate
}

export function classifyProblem(row: ItemProgressRate): ProblemKind | null {
  if (row.isStalled) return 'stalled'
  if (row.isOverQuantity) return 'over_quantity'
  if (row.workingDaysRemaining !== null && row.workingDaysRemaining > BEHIND_RATE_THRESHOLD_DAYS) return 'behind_rate'
  return null
}

function daysSince(dateStr: string | null, now: Date): number {
  if (!dateStr) return Number.POSITIVE_INFINITY
  const then = new Date(`${dateStr}T00:00:00`)
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000)
}

export function buildProblemList(rows: readonly ItemProgressRate[], now: Date): ProblemItem[] {
  const stalled = rows.filter((r) => classifyProblem(r) === 'stalled').sort((a, b) => daysSince(b.lastWorkDate, now) - daysSince(a.lastWorkDate, now))
  const overQuantity = rows
    .filter((r) => classifyProblem(r) === 'over_quantity')
    .sort((a, b) => b.quantityToDate - b.approximateQuantity - (a.quantityToDate - a.approximateQuantity))
  const behindRate = rows.filter((r) => classifyProblem(r) === 'behind_rate').sort((a, b) => (b.workingDaysRemaining ?? 0) - (a.workingDaysRemaining ?? 0))

  return [
    ...overQuantity.map((row) => ({ kind: 'over_quantity' as const, row })),
    ...behindRate.map((row) => ({ kind: 'behind_rate' as const, row })),
    ...stalled.map((row) => ({ kind: 'stalled' as const, row })),
  ]
}

// ─────────────────────────────────────────────────────────────────────────
// Overview's own "Needs attention" band splits over-quantity out from
// stalled/behind-rate entirely — over-quantity is a neutral fact (ahead of
// tendered quantity, already earned, not a fault), the other two are real
// problems. buildProblemList above stays as it was for ProgressScreen's
// per-contract list, which never asked for this split.
//
// Stalled detection is suppressed on a contract that isn't actively being
// worked — is_stalled has no notion of "the contract is over," so a
// finished-but-not-yet-active-again contract's every incomplete Item would
// otherwise read as stalled forever (Venables: paving finished 2026-07-31,
// contract_end not until 2026-08-10 — a date-based check would have kept
// flagging it as still active for another ten days, then never stopped
// flagging it after that either, since contract_end passing doesn't mean
// work stopped and work stopping doesn't mean the contract ended). A
// person's own contract_state is the only honest signal here — see
// ContractState (lib/supabase/contracts.ts). Suppression is stated, never
// silent — the caller surfaces suppressedStalledCount rather than just
// omitting the rows.
// ─────────────────────────────────────────────────────────────────────────

/** 'active' is the only state where an Item going quiet is a real problem — every other state (not yet started, wrapping up, closed, archived) means the absence of recent work is expected, not a fault. */
export function contractNeedsStalledSuppression(state: ContractState): boolean {
  return state !== 'active'
}

export interface AttentionResult {
  overQuantity: ProblemItem[]
  problems: ProblemItem[]
  /** Rows that WOULD read as stalled but were suppressed because the contract has finished — 0 when the contract hasn't finished, regardless of whether anything is actually stalled. */
  suppressedStalledCount: number
}

export function buildAttention(rows: readonly ItemProgressRate[], now: Date, contractFinished: boolean): AttentionResult {
  const overQuantity = rows
    .filter((r) => classifyProblem(r) === 'over_quantity')
    .sort((a, b) => b.quantityToDate - b.approximateQuantity - (a.quantityToDate - a.approximateQuantity))
  const wouldBeStalled = rows.filter((r) => classifyProblem(r) === 'stalled')
  const behindRate = rows.filter((r) => classifyProblem(r) === 'behind_rate').sort((a, b) => (b.workingDaysRemaining ?? 0) - (a.workingDaysRemaining ?? 0))
  const stalled = contractFinished ? [] : wouldBeStalled.sort((a, b) => daysSince(b.lastWorkDate, now) - daysSince(a.lastWorkDate, now))

  return {
    overQuantity: overQuantity.map((row) => ({ kind: 'over_quantity' as const, row })),
    problems: [...behindRate.map((row) => ({ kind: 'behind_rate' as const, row })), ...stalled.map((row) => ({ kind: 'stalled' as const, row }))],
    suppressedStalledCount: contractFinished ? wouldBeStalled.length : 0,
  }
}

/** The over-quantity group's own dollar reading — quantity above Approximate Quantity, at the tendered Unit Price, summed. Null contribution (no Unit Price on file) drops out via sumOrNull rather than reading as zero. */
export function overQuantityValueAboveSchedule(rows: readonly ProblemItem[], priceByItem: ReadonlyMap<string, ItemPrice>): number | null {
  return sumOrNull(
    rows.map(({ row }) => {
      const price = priceByItem.get(row.itemId)
      return price?.unitPrice != null ? (row.quantityToDate - row.approximateQuantity) * price.unitPrice : null
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Pipeline band — contract value under management (the tendered total),
// earned to date (the same valueToDate every other screen already uses,
// unit_price only — never redefined here), and backlog (what's left of the
// tendered total). Revenue-first, per the brief: a company margin figure
// would be computed over whichever handful of Items happen to be costed
// and would read as the whole picture, so margin never appears in this
// function at all — it's an optional, clearly-coverage-noted addition the
// screen layers on afterward, never blended into these three numbers.
// ─────────────────────────────────────────────────────────────────────────

export interface PipelineFigures {
  contractValue: number | null
  earned: number | null
  backlog: number | null
  percent: number | null
}

export function pipelineFigures(tenderPrice: number | null, valueToDate: number | null): PipelineFigures {
  const backlog = tenderPrice !== null && valueToDate !== null ? tenderPrice - valueToDate : null
  const percent = tenderPrice !== null && tenderPrice > 0 && valueToDate !== null ? valueToDate / tenderPrice : null
  return { contractValue: tenderPrice, earned: valueToDate, backlog, percent }
}

// ─────────────────────────────────────────────────────────────────────────
// Money makers — one row per Item, ranked by its own tendered value
// (Ext. amount, rowFinancials' own figure — the same one Rates shows and
// bars against), across every visible contract. A Lump Sum/Provisional Sum
// Item has a real tendered value but no quantity to read progress from at
// all (GC 52.03(b)/(c)) — quantityToDate/quantityPercent/valueEarned all
// stay null for those two kinds, on purpose, never zero.
// ─────────────────────────────────────────────────────────────────────────

export interface MoneyMakerRow {
  contractId: string
  contractLabel: string
  itemId: string
  itemNumber: string
  description: string
  itemKind: Item['itemKind']
  unit: string
  approximateQuantity: number
  quantityToDate: number | null
  quantityPercent: number | null
  valueEarned: number | null
  valueTendered: number | null
  margin: number | null
  marginPercent: number | null
}

// ─────────────────────────────────────────────────────────────────────────
// Overview's saved view preferences — which columns show, sort order, how
// many money-maker rows are visible, whether margin is on. Persisted
// server-side (user_view_preferences, scope 'overview_dashboard') but this
// sanitizer is what actually makes the whole mechanism safe: the fetched
// blob is untyped JSON that could be missing, stale (an old key from a
// shape this code no longer has), or outright malformed, and none of that
// may ever be allowed to break the screen for the person who saved it —
// every field falls back to its own default independently rather than the
// whole blob being accepted or rejected as one unit.
// ─────────────────────────────────────────────────────────────────────────

export type PipelineSortKey = 'value' | 'earned' | 'backlog' | 'percent'
export type MoneyMakerSortKey = 'value' | 'quantityPercent' | 'valueEarned' | 'margin'
export type SortDir = 'asc' | 'desc'

export interface OverviewPreferences {
  marginOn: boolean
  pipelineSortKey: PipelineSortKey
  pipelineSortDir: SortDir
  moneyMakerSortKey: MoneyMakerSortKey
  moneyMakerSortDir: SortDir
  moneyMakerVisibleCount: number
  showPipelineBacklog: boolean
  showPipelinePercent: boolean
  showMoneyMakerQuantity: boolean
  showMoneyMakerPercent: boolean
}

export const DEFAULT_OVERVIEW_PREFERENCES: OverviewPreferences = {
  marginOn: false,
  pipelineSortKey: 'value',
  pipelineSortDir: 'desc',
  moneyMakerSortKey: 'value',
  moneyMakerSortDir: 'desc',
  moneyMakerVisibleCount: 10,
  showPipelineBacklog: true,
  showPipelinePercent: true,
  showMoneyMakerQuantity: true,
  showMoneyMakerPercent: true,
}

const PIPELINE_SORT_KEYS: readonly PipelineSortKey[] = ['value', 'earned', 'backlog', 'percent']
const MONEY_MAKER_SORT_KEYS: readonly MoneyMakerSortKey[] = ['value', 'quantityPercent', 'valueEarned', 'margin']
const SORT_DIRS: readonly SortDir[] = ['asc', 'desc']
const VISIBLE_COUNT_OPTIONS = [5, 10, 25, 50]

export function sanitizeOverviewPreferences(raw: Record<string, unknown> | null): OverviewPreferences {
  const source = raw ?? {}
  const oneOf = <T,>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = source[key]
    return (allowed as readonly unknown[]).includes(v) ? (v as T) : fallback
  }
  const bool = (key: string, fallback: boolean): boolean => (typeof source[key] === 'boolean' ? (source[key] as boolean) : fallback)

  return {
    marginOn: bool('marginOn', DEFAULT_OVERVIEW_PREFERENCES.marginOn),
    pipelineSortKey: oneOf('pipelineSortKey', PIPELINE_SORT_KEYS, DEFAULT_OVERVIEW_PREFERENCES.pipelineSortKey),
    pipelineSortDir: oneOf('pipelineSortDir', SORT_DIRS, DEFAULT_OVERVIEW_PREFERENCES.pipelineSortDir),
    moneyMakerSortKey: oneOf('moneyMakerSortKey', MONEY_MAKER_SORT_KEYS, DEFAULT_OVERVIEW_PREFERENCES.moneyMakerSortKey),
    moneyMakerSortDir: oneOf('moneyMakerSortDir', SORT_DIRS, DEFAULT_OVERVIEW_PREFERENCES.moneyMakerSortDir),
    moneyMakerVisibleCount: oneOf('moneyMakerVisibleCount', VISIBLE_COUNT_OPTIONS, DEFAULT_OVERVIEW_PREFERENCES.moneyMakerVisibleCount),
    showPipelineBacklog: bool('showPipelineBacklog', DEFAULT_OVERVIEW_PREFERENCES.showPipelineBacklog),
    showPipelinePercent: bool('showPipelinePercent', DEFAULT_OVERVIEW_PREFERENCES.showPipelinePercent),
    showMoneyMakerQuantity: bool('showMoneyMakerQuantity', DEFAULT_OVERVIEW_PREFERENCES.showMoneyMakerQuantity),
    showMoneyMakerPercent: bool('showMoneyMakerPercent', DEFAULT_OVERVIEW_PREFERENCES.showMoneyMakerPercent),
  }
}

export function moneyMakerRow(params: {
  contractId: string
  contractLabel: string
  item: Item
  price: ItemPrice | undefined
  progress: ItemProgressRate | undefined
}): MoneyMakerRow {
  const { contractId, contractLabel, item, price, progress } = params
  const financials = rowFinancials({
    itemKind: item.itemKind,
    approximateQuantity: item.approximateQuantity,
    provisionalSum: item.provisionalSum,
    costPrice: price?.costPrice ?? null,
    costBasis: price?.costBasis ?? null,
    unitPrice: price?.unitPrice ?? null,
  })
  const isUnitPrice = item.itemKind === 'unit_price'
  const quantityToDate = isUnitPrice ? (progress?.quantityToDate ?? 0) : null
  const quantityPercent = isUnitPrice && item.approximateQuantity > 0 ? (quantityToDate ?? 0) / item.approximateQuantity : null
  const valueEarned = isUnitPrice && price?.unitPrice != null ? (quantityToDate ?? 0) * price.unitPrice : null
  return {
    contractId,
    contractLabel,
    itemId: item.id,
    itemNumber: item.itemNumber,
    description: item.description,
    itemKind: item.itemKind,
    unit: item.unit,
    approximateQuantity: item.approximateQuantity,
    quantityToDate,
    quantityPercent,
    valueEarned,
    valueTendered: financials.extAmount,
    margin: financials.margin,
    marginPercent: financials.marginPercent,
  }
}
