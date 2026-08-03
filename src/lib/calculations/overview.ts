import type { ItemProgressRate } from '../supabase/monthlyPeriods'

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

// ─────────────────────────────────────────────────────────────────────────
// Contract complete — quantity-weighted, not a count or an average of
// per-item percentages. An item that's 100 t into a 10,000 t item and one
// that's 100% done on a 10 t item are not equally "complete" for the
// contract as a whole; weighting by quantity is what makes the aggregate
// mean what it says.
// ─────────────────────────────────────────────────────────────────────────

export function weightedCompletion(rows: readonly { approximateQuantity: number; quantityToDate: number }[]): number | null {
  const totalApprox = rows.reduce((sum, r) => sum + r.approximateQuantity, 0)
  if (totalApprox <= 0) return null
  const totalToDate = rows.reduce((sum, r) => sum + r.quantityToDate, 0)
  return totalToDate / totalApprox
}

/** Started but not yet finished — Band 1's other headline figure, alongside weightedCompletion. Same rows (progressRate, already unit_price-only). */
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
