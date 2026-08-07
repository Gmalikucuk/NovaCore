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
// BEHIND_RATE_THRESHOLD_DAYS is six working weeks of remaining work at the
// observed rate — a real problem on any contract's timeline, not a
// threshold tuned to a specific season. It is used ONLY as an internal
// trigger for this classification now, not rendered — ProblemRow.tsx's
// "behind rate" sentence (as of the production-rate brief) states the
// observable facts the trigger was computed from instead of the day-count
// itself, since workingDaysRemaining is a projection and this screen
// doesn't state one. This is still the piece most likely to need a real
// value once a season boundary exists per contract — flagged in the
// handoff report.
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

// ─────────────────────────────────────────────────────────────────────────
// Contract-state participation in company-wide figures. Five states, three
// figures, each state answering a different question about each figure —
// see the brief's own rules table, reproduced exactly here rather than
// re-derived: pipeline counts toward contract value and backlog but not
// earned (nothing has been earned yet); active counts toward all three;
// warranty_period counts toward all three, same as active — its backlog
// reads near zero on its own, from the numbers, not because anything here
// forces it to; closed_out counts toward earned only — finished work is
// not pipeline and has no backlog remaining by definition; archived counts
// toward nothing, and is filtered out of the candidate set entirely by
// every caller before contractCountsToward is ever asked (see
// "archived: excluded from every figure and every list").
// ─────────────────────────────────────────────────────────────────────────

export type OverviewFigure = 'contractValue' | 'earned' | 'backlog'

const FIGURE_STATES: Record<OverviewFigure, ReadonlySet<ContractState>> = {
  contractValue: new Set<ContractState>(['pipeline', 'active', 'warranty_period']),
  earned: new Set<ContractState>(['active', 'warranty_period', 'closed_out']),
  backlog: new Set<ContractState>(['pipeline', 'active', 'warranty_period']),
}

export function contractCountsToward(figure: OverviewFigure, state: ContractState): boolean {
  return FIGURE_STATES[figure].has(state)
}

/** pipeline hasn't started: no Item progress to rank as a money-maker and no schedule to be behind or stalled on. Every other non-archived state participates normally — archived never reaches this check, filtered out upstream by every caller (same rule as contractCountsToward above). */
export function contractParticipatesInProduction(state: ContractState): boolean {
  return state !== 'pipeline'
}

export interface FigureCoverage {
  /** Eligible by state AND has the underlying number. */
  count: number
  /** Counts toward this figure by state, regardless of whether the number is actually on file yet. */
  eligible: number
  /** Every real (non-sandbox) contract considered, regardless of state. */
  total: number
}

export function figureCoverage(figure: OverviewFigure, rows: readonly { state: ContractState; hasData: boolean }[]): FigureCoverage {
  const eligibleRows = rows.filter((r) => contractCountsToward(figure, r.state))
  return { count: eligibleRows.filter((r) => r.hasData).length, eligible: eligibleRows.length, total: rows.length }
}

/**
 * "Covers N of M real contracts" — same convention Rates' own subtotal
 * coverage already uses. Two distinct reasons can each contribute a
 * clause: some contracts don't count toward this particular figure at all
 * (a closed_out contract in Contract value under management, say — not a
 * gap, a rule), and some that DO count are still missing the underlying
 * number (no tender price entered yet — an actual gap). Kept as two
 * separate clauses rather than one folded count, because they mean
 * different things to someone reconciling one figure against another: the
 * same contract can be the "excluded by state" reason on one figure and
 * not appear in either reason on the next, which is exactly the situation
 * that motivated stating this at all (see the brief's own "Coverage
 * language" section). Null — say nothing — only when the figure is
 * genuinely complete: every real contract both counts toward it and has
 * the number on file.
 */
export function coverageNote(coverage: FigureCoverage, missingDataReason: string): string | null {
  if (coverage.total === 0 || coverage.count === coverage.total) return null
  const parts: string[] = []
  if (coverage.eligible < coverage.total) parts.push(`${coverage.total - coverage.eligible} excluded by contract state`)
  if (coverage.count < coverage.eligible) parts.push(`${coverage.eligible - coverage.count} ${missingDataReason}`)
  return `Covers ${coverage.count} of ${coverage.total} real contracts — ${parts.join(', ')}`
}

/** Canonical display order — pipeline -> active -> warranty_period -> closed_out -> archived, the expected (not enforced) path a contract's own state moves through. */
export const CONTRACT_STATE_OPTIONS: readonly ContractState[] = ['pipeline', 'active', 'warranty_period', 'closed_out', 'archived']

/** Shared with ContractStateTag (components/ui.tsx) and the state-change control's own confirmation text — one label per state, defined once so neither can drift from the other. */
export const CONTRACT_STATE_LABEL: Record<ContractState, string> = {
  pipeline: 'Pipeline',
  active: 'Active',
  warranty_period: 'Warranty Period',
  closed_out: 'Closed out',
  archived: 'Archived',
}

/** The exact StatCard labels Overview renders these three figures under — shared so a confirmation ("this will leave Contract value under management") can never drift from the figure it's describing. */
export const OVERVIEW_FIGURE_LABEL: Record<OverviewFigure, string> = {
  contractValue: 'Contract value under management',
  earned: 'Earned to date',
  backlog: 'Backlog remaining',
}

export interface ContractStateFigureChange {
  figure: OverviewFigure
  /** true: the contract starts counting toward this figure; false: it stops. */
  gains: boolean
  /** This contract's own current value for the figure — null renders as an absent figure, not zero, same as everywhere else these three numbers appear. */
  amount: number | null
}

/**
 * What changing FROM one state TO another actually does to the three
 * company-wide figures — the plain-language content behind the
 * confirmation the brief asks for. Diffs contractCountsToward across all
 * three figures; a figure this contract already counted toward (or
 * already didn't) on both sides of the move is left out entirely, since
 * nothing about it changes. amounts carries this ONE contract's own
 * current numbers (not a company total) so the confirmation can say a
 * real figure, not just a rule.
 */
export function contractStateFigureChanges(
  fromState: ContractState,
  toState: ContractState,
  amounts: { contractValue: number | null; earned: number | null; backlog: number | null },
): ContractStateFigureChange[] {
  const figures: OverviewFigure[] = ['contractValue', 'earned', 'backlog']
  return figures.flatMap((figure) => {
    const was = contractCountsToward(figure, fromState)
    const now = contractCountsToward(figure, toState)
    if (was === now) return []
    return [{ figure, gains: now, amount: amounts[figure] }]
  })
}

/**
 * The other thing that changes with state and isn't one of the three money
 * figures: whether Needs Attention's stalled detection runs at all (see
 * contractNeedsStalledSuppression above). Surfaced separately rather than
 * folded into contractStateFigureChanges because it isn't a number on a
 * StatCard — active <-> warranty_period is the case that would otherwise
 * report "nothing changes," when in fact the one real thing that changes
 * for that specific move is this.
 */
export function contractStateStalledChange(fromState: ContractState, toState: ContractState): 'turns_on' | 'turns_off' | 'unchanged' {
  const was = contractNeedsStalledSuppression(fromState)
  const now = contractNeedsStalledSuppression(toState)
  if (was === now) return 'unchanged'
  return now ? 'turns_off' : 'turns_on'
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
  contractState: ContractState
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
  contractState: ContractState
  item: Item
  price: ItemPrice | undefined
  progress: ItemProgressRate | undefined
}): MoneyMakerRow {
  const { contractId, contractLabel, contractState, item, price, progress } = params
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
    contractState,
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
