const ROLLOVER_THRESHOLD = 5000
/** Tolerance for "checkpoint station falls within this segment" containment checks — comfortably above float noise, negligible relative to realistic station magnitudes. */
const STATION_EPSILON = 1e-6

export interface WidthReading {
  /** field entry order — the array must stay in this order, never sorted by station number */
  stationSequence: number
  /** metres from LKI origin, can reset (rollover) */
  station: number
  /** metres */
  width: number
}

export interface Segment {
  fromStation: number
  toStation: number
  length: number
  avgWidth: number
  area: number
  /** true when this segment's length was zeroed due to rollover */
  isRolloverBoundary: boolean
  /** width at fromStation — needed to solve for a station partway through a segment (width varies linearly, not just the average) */
  fromWidth: number
  /** width at toStation */
  toWidth: number
}

export function calculateSegments(readings: WidthReading[]): Segment[] {
  for (let i = 0; i < readings.length - 1; i++) {
    if (readings[i].stationSequence >= readings[i + 1].stationSequence) {
      throw new Error(
        `WidthReadings must be pre-sorted by stationSequence — received out-of-order input at index ${i + 1}.`,
      )
    }
  }

  const segments: Segment[] = []

  for (let i = 0; i < readings.length - 1; i++) {
    const a = readings[i]
    const b = readings[i + 1]

    const rawDiff = b.station - a.station
    const isRolloverBoundary = Math.abs(rawDiff) > ROLLOVER_THRESHOLD
    const length = isRolloverBoundary ? 0 : Math.abs(rawDiff)
    const avgWidth = (a.width + b.width) / 2
    const area = avgWidth * length

    segments.push({
      fromStation: a.station,
      toStation: b.station,
      length,
      avgWidth,
      area,
      isRolloverBoundary,
      fromWidth: a.width,
      toWidth: b.width,
    })
  }

  return segments
}

export function cumulativeArea(segments: Segment[]): number {
  return segments.reduce((sum, segment) => sum + segment.area, 0)
}

/**
 * Cumulative paved area from the start of the reading walk up to an
 * arbitrary checkpoint station, which may fall partway through a segment
 * rather than exactly on a reading boundary. Powers the live
 * application-rate checkpoint on PavingEntryScreen — a real-time
 * self-monitoring approximation, not the authoritative per-truck
 * reconstruction (see truckDistribution.ts for that).
 *
 * Reuses the exact linear-width-interpolation model truckDistribution.ts's
 * segment walk already uses for "area from the start of a segment to a
 * partial point within it": width(s) = fromWidth + ((toWidth-fromWidth)/length)*s
 * for distance-along-segment s, so cumulative area at s is the integral
 * a*s^2 + b*s where a = (toWidth-fromWidth)/(2*length), b = fromWidth — see
 * areaFromPosToEnd/areaAtPos in truckDistribution.ts for the same formula
 * used the other way around (segment end minus this).
 *
 * Two passes, deliberately not a single running-total walk: raw station
 * numbers aren't monotonic across a rollover, so a checkpoint physically
 * reached only AFTER a rollover can have a locally "negative" distance
 * against every segment that came before the jump (e.g. checkpoint 30 vs. a
 * segment starting at 45050 — clearly earlier in the walk, not later, but
 * the raw arithmetic looks identical to a checkpoint genuinely typed before
 * the session even started). Pass 1 finds which segment actually contains
 * the checkpoint by local containment alone, independent of ordering. Pass
 * 2 sums everything strictly before that segment — once the containing
 * segment is known, everything preceding it in the array is unambiguously
 * "already paved," rollover or not.
 */
export function cumulativeAreaToStation(segments: Segment[], checkpointStation: number): number {
  let matchIndex = -1
  let matchPartialArea = 0

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    if (segment.length === 0) continue

    const direction = segment.toStation > segment.fromStation ? 1 : -1
    const distanceAlongSegment = (checkpointStation - segment.fromStation) * direction

    if (distanceAlongSegment >= -STATION_EPSILON && distanceAlongSegment <= segment.length + STATION_EPSILON) {
      const clampedDistance = Math.min(Math.max(distanceAlongSegment, 0), segment.length)
      const a = (segment.toWidth - segment.fromWidth) / (2 * segment.length)
      const b = segment.fromWidth
      matchIndex = i
      matchPartialArea = a * clampedDistance * clampedDistance + b * clampedDistance
      break
    }
  }

  if (matchIndex !== -1) {
    return cumulativeArea(segments.slice(0, matchIndex)) + matchPartialArea
  }

  // No segment contains the checkpoint outright — it's either before the
  // session's own starting station (nothing paved there yet) or beyond
  // every reading taken so far (report everything walked, not an error or
  // a guess past the crew's actual progress). Direction is read from the
  // first real (non-zero-length) segment specifically, since that's the one
  // unambiguous reference point no rollover could have touched yet.
  const first = segments.find((s) => s.length > 0)
  if (!first) return 0
  const firstDirection = first.toStation > first.fromStation ? 1 : -1
  const distanceFromStart = (checkpointStation - first.fromStation) * firstDirection

  return distanceFromStart < 0 ? 0 : cumulativeArea(segments)
}
