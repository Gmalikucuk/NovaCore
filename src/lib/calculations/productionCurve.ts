// ─────────────────────────────────────────────────────────────────────────
// The production curve (Progress) — one small chart per pinned Item,
// cumulative recorded quantity against calendar time. Sibling to the
// station ribbon (stationRibbon.ts): same screen, same pinned-Item
// selection, same effective-record source, different axis — time instead
// of station. groupByItem is imported from stationRibbon.ts rather than
// redefined here; it was already generic over any record with an itemId,
// which is exactly what this needs too.
//
// Actual only. No planned baseline, no forecast, no projection — see this
// brief's own "Why actual-only matters." The only two things this module
// computes are "how much, cumulatively, by when" and "where does that put
// the axes," both pure geometry, no I/O.
// ─────────────────────────────────────────────────────────────────────────

import { parseLocalDate } from '../dateFormat'
import { groupByItem } from './stationRibbon'

export { groupByItem }

export interface ProductionRecord {
  itemId: string
  workDate: string
  quantity: number
}

export interface CumulativePoint {
  date: string
  cumulative: number
}

/**
 * One item's records collapsed to a cumulative step series: same-day
 * records summed together (a crew can log more than one entry a day),
 * dates sorted ascending, each point the running total as of that date.
 * Empty in, empty out — a pinned Item with no records of its own gets no
 * points, which the caller renders as its own empty state, not a chart
 * with nothing on it.
 */
export function cumulativeSeries(records: readonly Pick<ProductionRecord, 'workDate' | 'quantity'>[]): CumulativePoint[] {
  const byDate = new Map<string, number>()
  for (const r of records) {
    byDate.set(r.workDate, (byDate.get(r.workDate) ?? 0) + r.quantity)
  }
  const dates = [...byDate.keys()].sort()
  let running = 0
  return dates.map((date) => {
    running += byDate.get(date) as number
    return { date, cumulative: running }
  })
}

export interface DateRange {
  loDate: string
  hiDate: string
}

/**
 * The x-axis span for one chart — the Item's OWN first and last work_date,
 * not the contract's, mirroring how the ribbon's axisRange is computed per
 * segment block from just that block's own data rather than a shared
 * contract-wide span. A small multiple reads best scaled to its own
 * working window; forcing every pinned Item onto one contract-wide date
 * range would squash an Item that worked three weeks into a corner of an
 * eight-week frame it never touched.
 */
export function dateRange(points: readonly Pick<CumulativePoint, 'date'>[]): DateRange | null {
  if (points.length === 0) return null
  const dates = points.map((p) => p.date)
  return { loDate: dates.reduce((a, b) => (a < b ? a : b)), hiDate: dates.reduce((a, b) => (a > b ? a : b)) }
}

/** Position, as a percentage of the axis, for a date within a range — degenerate (single-day) ranges map to 0%, not NaN from a zero-width division. */
export function datePercent(range: DateRange, date: string): number {
  const lo = parseLocalDate(range.loDate).getTime()
  const hi = parseLocalDate(range.hiDate).getTime()
  const span = hi - lo || 1
  return ((parseLocalDate(date).getTime() - lo) / span) * 100
}

/**
 * Adaptive tick step for the date axis — daily for a short window, weekly
 * for a month or so, otherwise roughly fortnightly, so a two-week job and
 * a two-month one both get a readable, not-overcrowded set of ticks.
 * Stops at the last multiple of the step that fits within the range,
 * same as the ribbon's axisTicks — it does NOT force a final tick exactly
 * at hiDate, which would sit awkwardly close to the previous tick more
 * often than not. The exact endpoints are shown separately, as the
 * ribbon shows its "km lo → hi" caption below the ticks rather than
 * bending the tick ladder to hit them.
 */
export function dateTicks(range: DateRange): string[] {
  const loTime = parseLocalDate(range.loDate).getTime()
  const hiTime = parseLocalDate(range.hiDate).getTime()
  const spanDays = Math.round((hiTime - loTime) / (1000 * 60 * 60 * 24))
  const stepDays = spanDays > 42 ? 14 : spanDays > 14 ? 7 : spanDays > 5 ? 2 : 1
  const stepMs = stepDays * 24 * 60 * 60 * 1000
  const ticks: string[] = []
  for (let t = loTime; t <= hiTime; t += stepMs) {
    ticks.push(new Date(t).toISOString().slice(0, 10))
  }
  return ticks
}

export interface QuantityRange {
  lo: number
  hi: number
}

/**
 * The y-axis span, in the Item's own unit — always from 0 (a cumulative
 * total is never negative), up to whichever is larger: the curve's own
 * peak or the Approximate Quantity reference. An Item that finishes under
 * its Approximate Quantity gets headroom above the curve so the reference
 * line is visible, not flush against the top edge; an Item that runs over
 * gets headroom above ITS OWN peak instead, so the curve past the
 * reference line is still fully on the chart, not clipped at the frame.
 */
export function quantityRange(points: readonly Pick<CumulativePoint, 'cumulative'>[], approximateQuantity: number): QuantityRange {
  const peak = points.reduce((max, p) => Math.max(max, p.cumulative), 0)
  const hi = Math.max(peak, approximateQuantity, 1) * 1.08
  return { lo: 0, hi }
}

/** Position, as a percentage of the axis (0% at the bottom), for a quantity value within a range. */
export function quantityPercent(range: QuantityRange, value: number): number {
  const span = range.hi - range.lo || 1
  return ((value - range.lo) / span) * 100
}

// ─────────────────────────────────────────────────────────────────────────
// Observed rate — plain arithmetic beside the curve, not a forecast. See
// this brief's own "What this is, and what it is emphatically not": four
// facts (quantity to date, working days, rate per working day, remaining),
// no projected completion, no season comparison. Derived entirely from the
// same cumulativeSeries() the curve already draws — points.length IS the
// working-day count (cumulativeSeries already collapses same-day records
// and keys one point per distinct work_date), and the last point's
// cumulative IS quantity to date. No second fetch, no second rule.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Below this many working days, a rate is noise rather than signal — one
 * unusually large or small day can swing the average by a wide margin. At
 * 5, no single day can be more than a fifth of the sample. Chosen for the
 * same reason RatesScreen suppresses its margin bands below ten priced
 * Items: a stated figure that would visibly jump on the next single data
 * point reads as more certain than it is, so it's better not shown at all.
 * Inclusive — an Item with exactly 5 working days still gets a rate; it's
 * a thin sample, not a forbidden one.
 */
export const MIN_WORKING_DAYS_FOR_RATE = 5

export interface ProductionFigures {
  quantityToDate: number
  workingDays: number
  /** approximateQuantity - quantityToDate. Negative means the Item has recorded past its Approximate Quantity — a surplus, not a deficit; callers render the sign, not the word "remaining," in that case. */
  remaining: number
}

/** The three base facts derivable from a cumulative series alone — quantity to date, the working-day count, and signed remaining. Null for an Item with no records, same as every other empty-input case in this module. */
export function productionFigures(points: readonly Pick<CumulativePoint, 'cumulative'>[], approximateQuantity: number): ProductionFigures | null {
  if (points.length === 0) return null
  const quantityToDate = points[points.length - 1].cumulative
  return { quantityToDate, workingDays: points.length, remaining: approximateQuantity - quantityToDate }
}

/** quantityToDate / workingDays — meaningless at workingDays = 0, but productionFigures never returns that (points.length >= 1 whenever it returns non-null). */
export function ratePerWorkingDay(figures: Pick<ProductionFigures, 'quantityToDate' | 'workingDays'>): number {
  return figures.quantityToDate / figures.workingDays
}

/** Whether the working-day sample is large enough to state a rate at all — see MIN_WORKING_DAYS_FOR_RATE's own doc comment for why 5, and why inclusive. */
export function hasEnoughWorkingDaysForRate(workingDays: number): boolean {
  return workingDays >= MIN_WORKING_DAYS_FOR_RATE
}
