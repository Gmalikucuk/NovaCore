export interface Interval {
  lo: number
  hi: number
}

/**
 * Classic sweep-line interval merge — sorts by lo (then hi), and starts a
 * new merge group whenever the current interval's lo falls strictly past
 * the running max hi of everything merged so far (a real gap). Touching
 * intervals (lo === running max hi) merge. Same rule as
 * segment_group_completion_status's SQL merge in
 * supabase/migrations/20260705110000_lifecycle_event_station_coverage.sql
 * ("Touching intervals (lo == running_max) merge, matching
 * next.from_station <= running_max_to_station"), reimplemented here as a
 * plain, testable function instead of a raw SQL window-function query —
 * that view is specific to surface_lifecycle_events coverage types and
 * isn't callable generically, so this is the reusable form of the same
 * algorithm.
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((a, b) => (a.lo !== b.lo ? a.lo - b.lo : a.hi - b.hi))

  const merged: Interval[] = []
  let currentLo = sorted[0].lo
  let currentHi = sorted[0].hi

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]
    if (next.lo > currentHi) {
      merged.push({ lo: currentLo, hi: currentHi })
      currentLo = next.lo
      currentHi = next.hi
    } else {
      currentHi = Math.max(currentHi, next.hi)
    }
  }
  merged.push({ lo: currentLo, hi: currentHi })

  return merged
}

/**
 * Returns the covered interval a station falls strictly inside, or null if
 * it doesn't — landing exactly on a boundary (continuing from where
 * coverage currently ends, or backing onto where it currently starts) is
 * valid and expected, not a violation.
 */
export function findStrictlyInsideCoverage(station: number, merged: Interval[]): Interval | null {
  for (const interval of merged) {
    if (station > interval.lo && station < interval.hi) return interval
  }
  return null
}

/**
 * True when a station falls within (inclusive of both boundaries) at least
 * one already-merged interval. Used for Paving's coverage-against-milling
 * check: a paving station must land somewhere milling has actually milled,
 * which is a different question from findStrictlyInsideCoverage's
 * boundary-exclusive "is this a self-referential double-entry" check —
 * landing exactly on milling's own boundary is still validly-milled ground,
 * not a violation.
 */
export function isStationWithinCoverage(station: number, merged: Interval[]): boolean {
  return merged.some((interval) => station >= interval.lo && station <= interval.hi)
}

/**
 * True when some already-merged interval spans the entire [lo, hi] range —
 * i.e. a whole segment's declared station range has confirmed readings
 * covering it end to end, with no gap. Used to decide whether a past
 * session is worth resuming (fully covered ones have nothing left to add).
 */
export function isRangeFullyCovered(lo: number, hi: number, merged: Interval[]): boolean {
  return merged.some((interval) => interval.lo <= lo && interval.hi >= hi)
}
