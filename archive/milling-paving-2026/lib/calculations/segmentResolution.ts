export interface SegmentRange {
  id: string
  fromStation: number
  toStation: number
  highway2FromStation: number | null
  highway2ToStation: number | null
}

function stationInRange(station: number, a: number, b: number): boolean {
  return station >= Math.min(a, b) && station <= Math.max(a, b)
}

function segmentContainsStation(segment: SegmentRange, station: number): boolean {
  if (stationInRange(station, segment.fromStation, segment.toStation)) return true
  if (segment.highway2FromStation !== null && segment.highway2ToStation !== null) {
    return stationInRange(station, segment.highway2FromStation, segment.highway2ToStation)
  }
  return false
}

/**
 * Resolves which segment a station belongs to. Station ranges are not
 * globally unique — two unrelated segments (different highways in the same
 * contract) can cover overlapping station numbers — so this never does a
 * blind "find any segment containing this station" scan. It always checks
 * the currently active segment first and only considers switching to a
 * different candidate when the station falls outside the active segment's
 * range(s).
 */
export function resolveSegmentForStation(
  station: number,
  candidates: SegmentRange[],
  activeSegmentId: string | null,
): SegmentRange | null {
  if (activeSegmentId !== null) {
    const active = candidates.find((c) => c.id === activeSegmentId)
    if (active && segmentContainsStation(active, station)) return active
  }
  return candidates.find((c) => segmentContainsStation(c, station)) ?? null
}
