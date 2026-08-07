import {
  cumulativeSeries,
  dateRange,
  datePercent,
  dateTicks,
  quantityRange,
  quantityPercent,
  productionFigures,
  ratePerWorkingDay,
  hasEnoughWorkingDaysForRate,
  MIN_WORKING_DAYS_FOR_RATE,
  type ProductionRecord,
} from '../lib/calculations/productionCurve'
import { formatDayLabel, formatDayTick } from '../lib/dateFormat'
import { quantity as fmtQuantity } from '../lib/format'
import { StatusBadge } from './ui'

export interface CurveItem {
  id: string
  itemNumber: string
  description: string
  unit: string
  approximateQuantity: number
}

const CHART_W = 600
const CHART_H = 110

/**
 * A step-after path from (loDate, 0) through every cumulative point — flat
 * between record dates, a vertical jump on the date a record actually
 * landed. NOT a straight line between sparse points: that would draw a
 * slope across a day nobody worked, implying steady progress that never
 * happened. Coordinates are pre-mapped to the SVG viewBox by the caller;
 * this only sequences the step shape.
 */
function stepPath(points: readonly { x: number; y: number }[], groundY: number): string {
  if (points.length === 0) return ''
  const [first, ...rest] = points
  const commands = [`M 0,${groundY}`, `L 0,${first.y}`]
  let prevY = first.y
  for (const p of rest) {
    commands.push(`L ${p.x},${prevY}`)
    commands.push(`L ${p.x},${p.y}`)
    prevY = p.y
  }
  return commands.join(' ')
}

/**
 * One small step chart per pinned Item, stacked — the production curve
 * (Progress). Sibling to StationRibbon: same screen, same pinned-Item
 * selection, same effective records, time on the axis instead of station.
 *
 * Each Item gets its own y-axis in its own unit — tonnes and square
 * metres are not comparable, so no shared scale is attempted. The x-axis
 * (time) is likewise scaled per item to that item's own first-to-last
 * work date, not a contract-wide span (see productionCurve.ts's
 * dateRange doc comment for why).
 *
 * Actual only: no planned baseline, no forecast. The Approximate Quantity
 * reference line is a contract figure (what the Ministry expects), not a
 * plan — drawn the same neutral dashed line whether the curve is under or
 * over it. Where the curve finishes over that line, the "over" badge
 * reuses the app's existing neutral over-quantity tone (StatusBadge
 * status="over") — a gain worth noting, not a fault worth a danger colour.
 *
 * Beneath each chart, four plain facts (productionFigures/ratePerWorkingDay
 * in productionCurve.ts): quantity to date, working days, the resulting
 * rate, and remaining (or surplus, unclamped, when over). Arithmetic on
 * records that exist, not a projection — no completion date, no season
 * comparison, nothing stated below MIN_WORKING_DAYS_FOR_RATE working days,
 * where a rate would be noise dressed as a figure.
 */
export function ProductionCurve({ items, records }: { items: readonly CurveItem[]; records: readonly ProductionRecord[] }) {
  const byItem = new Map<string, ProductionRecord[]>()
  for (const r of records) {
    const list = byItem.get(r.itemId) ?? []
    list.push(r)
    byItem.set(r.itemId, list)
  }

  return (
    <div className="flex flex-col gap-4">
      {items.map((item) => {
        const itemRecords = byItem.get(item.id) ?? []
        const points = cumulativeSeries(itemRecords)

        if (points.length === 0) {
          return (
            <div key={item.id} className="rounded-lg border border-nc-border bg-white p-4">
              <p className="text-sm">
                <span className="nc-numeric font-semibold text-nc-text">{item.itemNumber}</span> <span className="text-nc-text-muted">{item.description}</span>
              </p>
              <p className="mt-2 text-sm text-nc-text-muted">This Item is pinned, but has no confirmed records of its own yet.</p>
            </div>
          )
        }

        const range = dateRange(points)
        if (range === null) return null
        const qRange = quantityRange(points, item.approximateQuantity)
        const ticks = dateTicks(range)
        const lastCumulative = points[points.length - 1].cumulative
        const isOver = lastCumulative > item.approximateQuantity

        const toSvg = (p: { date: string; cumulative: number }) => ({
          x: (datePercent(range, p.date) / 100) * CHART_W,
          y: CHART_H - (quantityPercent(qRange, p.cumulative) / 100) * CHART_H,
        })
        const svgPoints = points.map(toSvg)
        const groundY = CHART_H
        const path = stepPath(svgPoints, groundY)
        const referenceY = CHART_H - (quantityPercent(qRange, item.approximateQuantity) / 100) * CHART_H

        return (
          <div key={item.id} className="rounded-lg border border-nc-border bg-white p-4">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <p className="text-sm">
                <span className="nc-numeric font-semibold text-nc-text">{item.itemNumber}</span> <span className="text-nc-text-muted">{item.description}</span>
              </p>
              <div className="flex items-center gap-2">
                {isOver && <StatusBadge status="over">Over Approx. Quantity</StatusBadge>}
                <span className="nc-numeric text-sm text-nc-text-muted">
                  {fmtQuantity(lastCumulative)} of {fmtQuantity(item.approximateQuantity, item.unit)}
                </span>
              </div>
            </div>

            <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="h-28 w-full text-nc-navy" preserveAspectRatio="none" aria-hidden="true">
              <line x1={0} y1={referenceY} x2={CHART_W} y2={referenceY} className="text-nc-text-subtle" stroke="currentColor" strokeWidth={1} strokeDasharray="4 4" />
              <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
            </svg>

            <div className="mt-1 flex items-center justify-between text-[10px] text-nc-text-muted">
              <span>0</span>
              <span className="nc-numeric">Approx. {fmtQuantity(item.approximateQuantity, item.unit)}</span>
            </div>

            <div className="relative mt-1 h-4">
              {ticks.map((t) => (
                <span key={t} className="nc-numeric absolute -translate-x-1/2 whitespace-nowrap text-[10px] text-nc-text-muted" style={{ left: `${datePercent(range, t)}%` }}>
                  {formatDayTick(t)}
                </span>
              ))}
            </div>
            <p className="nc-numeric mt-1 text-xs text-nc-text-muted">
              {range.loDate === range.hiDate ? formatDayLabel(range.loDate) : `${formatDayLabel(range.loDate)} → ${formatDayLabel(range.hiDate)}`}
            </p>

            {(() => {
              const figures = productionFigures(points, item.approximateQuantity)
              if (figures === null) return null
              const enoughForRate = hasEnoughWorkingDaysForRate(figures.workingDays)
              const rate = enoughForRate ? ratePerWorkingDay(figures) : null
              const workingDayWord = figures.workingDays === 1 ? 'working day' : 'working days'
              const isSurplus = figures.remaining < 0
              return (
                <div className="mt-2 border-t border-nc-border pt-2 text-xs text-nc-text">
                  <p className="nc-numeric">
                    {rate !== null
                      ? `${fmtQuantity(figures.quantityToDate, item.unit)} over ${figures.workingDays} ${workingDayWord} — ${fmtQuantity(rate, item.unit)} per working day`
                      : `${fmtQuantity(figures.quantityToDate, item.unit)} over ${figures.workingDays} ${workingDayWord} — no rate stated below ${MIN_WORKING_DAYS_FOR_RATE} working days.`}
                  </p>
                  <p className="nc-numeric mt-1">
                    {isSurplus ? `${fmtQuantity(Math.abs(figures.remaining), item.unit)} surplus — over Approximate Quantity` : `${fmtQuantity(figures.remaining, item.unit)} remaining`}
                  </p>
                </div>
              )
            })()}
          </div>
        )
      })}
    </div>
  )
}
