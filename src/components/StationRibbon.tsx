import { axisPercent, axisRange, axisTicks, barSpan, groupByItem, groupBySegment, sortSegments, type StationRecord } from '../lib/calculations/stationRibbon'
import { station, stationDecimal } from '../lib/format'

export interface RibbonItem {
  id: string
  itemNumber: string
  description: string
}

/**
 * One lane per pinned Item, stretches drawn where confirmed work has been
 * recorded, on a shared station axis — one axis PER LKI segment, since
 * station is only unique within a segment (Snowshed Hill spans 2090 and
 * 2091; two stretches on different segments must never share one axis).
 * Every pinned Item gets a lane in every segment block, even an empty one
 * — the axis alignment across segments only means something if the same
 * set of lanes appears in each.
 *
 * Neutral tone throughout: this is coverage, not status. The only
 * judgement is drawn or not drawn — a gap between two lanes is visible
 * because the axis is shared, never called out with an alert colour.
 */
export function StationRibbon({ items, records }: { items: readonly RibbonItem[]; records: readonly StationRecord[] }) {
  const bySegment = groupBySegment(records)
  const segments = sortSegments([...bySegment.keys()])

  return (
    <div className="flex flex-col gap-6">
      {segments.map((segment) => {
        const segmentRecords = bySegment.get(segment) ?? []
        const range = axisRange(segmentRecords)
        if (range === null) return null
        const ticks = axisTicks(range)
        const recordsByItem = groupByItem(segmentRecords)

        return (
          <div key={segment ?? 'none'} className="rounded-lg border border-nc-border bg-white p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-nc-text-muted">
              {segment === null ? 'No LKI segment recorded' : `LKI segment ${segment}`}
            </p>

            <div className="flex flex-col gap-2">
              {items.map((item) => {
                const itemRecords = recordsByItem.get(item.id) ?? []
                return (
                  <div key={item.id} className="flex items-center gap-3">
                    <div className="w-64 shrink-0 truncate text-sm" title={`${item.itemNumber} ${item.description}`}>
                      <span className="nc-numeric font-semibold text-nc-text">{item.itemNumber}</span> <span className="text-nc-text-muted">{item.description}</span>
                    </div>
                    <div className="relative h-6 flex-1">
                      <div className="absolute inset-x-0 top-2.5 h-1.5 rounded-sm border border-nc-border bg-nc-page" />
                      {itemRecords.map((r, i) => {
                        const span = barSpan(r)
                        const left = axisPercent(range, span.left)
                        if (span.isPoint) {
                          return (
                            <div
                              key={i}
                              title={station(span.left)}
                              className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-nc-navy"
                              style={{ left: `${left}%` }}
                            />
                          )
                        }
                        const right = axisPercent(range, span.right)
                        const width = Math.max(0.6, right - left)
                        return (
                          <div
                            key={i}
                            title={`${station(span.left)}–${station(span.right)}`}
                            className="absolute top-1.5 h-3 min-w-[3px] rounded-sm bg-nc-navy"
                            style={{ left: `${left}%`, width: `${width}%` }}
                          />
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="relative ml-[17.5rem] mt-1 h-4">
              {ticks.map((t) => (
                <div key={t} className="nc-numeric absolute -translate-x-1/2 whitespace-nowrap text-[10px] text-nc-text-muted" style={{ left: `${axisPercent(range, t)}%` }}>
                  {stationDecimal(t, range.hi - range.lo > 4 ? 0 : 1)}
                </div>
              ))}
            </div>
            <p className="nc-numeric mt-2 text-xs text-nc-text-muted">
              km {station(range.lo)} → {station(range.hi)}
            </p>
          </div>
        )
      })}
    </div>
  )
}
