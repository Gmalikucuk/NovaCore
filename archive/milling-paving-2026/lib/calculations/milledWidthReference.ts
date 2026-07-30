export interface MillingReferencePoint {
  station: number
  width: number
}

/**
 * The milled width "at" a given paving station, per the direction of
 * travel — the nearest prior milling reading already passed (by station
 * value, not milling's own field-entry order — milling may have walked
 * this segment in either direction independent of paving's own), held flat
 * until a newer one supersedes it. A step function, deliberately NOT the
 * linear interpolation calculateSegments uses for area totals — this is a
 * quick field reference the crew can see at a glance, not a value anything
 * gets calculated from (see PavingEntryScreen: "the field person can enter
 * whatever real width they measured").
 *
 * Returns null when nothing has been passed yet in this direction — e.g.
 * paving starts before the first milling reading in its walk — rather than
 * defaulting to some fabricated value.
 */
export function findMilledWidthReference(
  station: number,
  direction: 'ascending' | 'descending',
  millingReadings: MillingReferencePoint[],
): number | null {
  let best: MillingReferencePoint | null = null
  for (const reading of millingReadings) {
    const passed = direction === 'ascending' ? reading.station <= station : reading.station >= station
    if (!passed) continue
    const closer = best === null || (direction === 'ascending' ? reading.station > best.station : reading.station < best.station)
    if (closer) best = reading
  }
  return best ? best.width : null
}
