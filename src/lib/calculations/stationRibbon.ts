// ─────────────────────────────────────────────────────────────────────────
// The station ribbon (Progress) — one lane per pinned Item, stretches drawn
// where confirmed work has been recorded, on a shared station axis per LKI
// segment. Pure geometry only; fetching and grouping by Item/segment happen
// in the caller.
//
// Deliberately NOT shared code with ChainageStrip.tsx (EntryScreen's own
// single-strip, one-day, status-coloured view) — same core min/max-based
// span insight, reused as a pattern, not as shared code: this component is
// multi-lane, multi-segment, and neutral-toned (coverage, not status),
// different enough in shape that sharing an implementation would couple
// two independently-evolving screens for a resemblance that's skin deep.
// ─────────────────────────────────────────────────────────────────────────

export interface StationRecord {
  itemId: string
  stationFrom: number
  /** null = a point-located record (a mark, not a span) — never treated as zero-width by accident; barSpan() below makes this explicit. */
  stationTo: number | null
  lkiSegment: number | null
}

export interface BarSpan {
  left: number
  right: number
  isPoint: boolean
}

/**
 * A record's drawn extent — left/right on an ASCENDING station axis,
 * independent of travel direction. station_from is not assumed to be the
 * lesser value: stations descend against travel on some jobs (Venables
 * paved 10+725 to 9+175 southbound), so the span is always
 * min/max of the two recorded values, never the raw from/to order. A null
 * station_to collapses left and right to the same point — a mark, not a
 * span.
 */
export function barSpan(record: Pick<StationRecord, 'stationFrom' | 'stationTo'>): BarSpan {
  if (record.stationTo === null) {
    return { left: record.stationFrom, right: record.stationFrom, isPoint: true }
  }
  return { left: Math.min(record.stationFrom, record.stationTo), right: Math.max(record.stationFrom, record.stationTo), isPoint: false }
}

/**
 * Records grouped by LKI segment — station is only unique WITHIN a
 * segment, so two stretches on different segments must never share one
 * axis. null (no segment recorded) is its own group, not merged with any
 * numbered one.
 */
export function groupBySegment<T extends { lkiSegment: number | null }>(records: readonly T[]): Map<number | null, T[]> {
  const map = new Map<number | null, T[]>()
  for (const r of records) {
    const list = map.get(r.lkiSegment) ?? []
    list.push(r)
    map.set(r.lkiSegment, list)
  }
  return map
}

/** Records grouped by Item — one lane's worth per key, within a segment already isolated by groupBySegment. */
export function groupByItem<T extends { itemId: string }>(records: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const r of records) {
    const list = map.get(r.itemId) ?? []
    list.push(r)
    map.set(r.itemId, list)
  }
  return map
}

/** Numbered segments ascending, then "no segment recorded" last — the least-specified case, not the default one. */
export function sortSegments(segments: readonly (number | null)[]): (number | null)[] {
  return [...segments].sort((a, b) => {
    if (a === null) return 1
    if (b === null) return -1
    return a - b
  })
}

export interface AxisRange {
  lo: number
  hi: number
}

/**
 * The axis span for one segment's worth of records — derived from the
 * data being shown, not from any stored contract-level range (there is
 * none; see this brief's own investigation). Rounded outward to a round
 * tenth so lanes read as "about this stretch of highway," not a jagged
 * edge at the first and last decimal recorded. A degenerate span (one
 * point, or a very short stretch) is widened to a minimum so it isn't
 * invisible. Null for an empty record set — nothing to draw, nothing to
 * measure.
 */
export function axisRange(records: readonly Pick<StationRecord, 'stationFrom' | 'stationTo'>[]): AxisRange | null {
  if (records.length === 0) return null
  const values = records.flatMap((r) => {
    const span = barSpan(r)
    return [span.left, span.right]
  })
  let lo = Math.floor(Math.min(...values) * 10) / 10
  let hi = Math.ceil(Math.max(...values) * 10) / 10
  if (hi - lo < 0.2) hi = lo + 0.2
  return { lo, hi }
}

/** Adaptive tick step — the same granularity ladder ChainageStrip uses, so a small or large span both read cleanly. */
export function axisTicks(range: AxisRange): number[] {
  const span = range.hi - range.lo || 1
  const step = span > 10 ? 2 : span > 4 ? 1 : span > 1 ? 0.5 : 0.1
  const ticks: number[] = []
  for (let k = Math.ceil(range.lo / step) * step; k <= range.hi + 1e-9; k += step) {
    ticks.push(Math.round(k * 1000) / 1000)
  }
  return ticks
}

/** Position, as a percentage of the axis, for a station value — the sole conversion from km to layout. */
export function axisPercent(range: AxisRange, value: number): number {
  const span = range.hi - range.lo || 1
  return ((value - range.lo) / span) * 100
}
