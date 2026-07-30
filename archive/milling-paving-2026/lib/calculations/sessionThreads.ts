export interface StationPoint {
  station: number
}

export interface SessionThread<T extends StationPoint> {
  direction: 'ascending' | 'descending' | null
  readings: T[]
}

/**
 * Splits one segment-day's readings (already in field-entry order) into
 * disjoint direction-of-travel threads — a new thread starts wherever the
 * station-to-station direction reverses, which is how a segment-cut
 * exception (or any other reason a crew restarted somewhere else on the
 * same segment/day) actually shows up in the data, since ascending/
 * descending itself is never stored server-side. A thread made of a single
 * reading has no direction of its own to infer (there's no delta to read
 * it from) — direction stays null rather than guessing, so callers can
 * require the person to confirm it explicitly instead of trusting a guess.
 */
export function splitIntoThreads<T extends StationPoint>(readings: T[]): SessionThread<T>[] {
  const threads: SessionThread<T>[] = []
  let current: T[] = []
  let currentSign: 1 | -1 | null = null

  for (const reading of readings) {
    if (current.length === 0) {
      current.push(reading)
      continue
    }

    const delta = reading.station - current[current.length - 1].station
    const sign: 1 | -1 | null = delta === 0 ? null : delta > 0 ? 1 : -1

    if (currentSign === null || sign === null || sign === currentSign) {
      if (currentSign === null && sign !== null) currentSign = sign
      current.push(reading)
    } else {
      threads.push({ direction: currentSign === 1 ? 'ascending' : 'descending', readings: current })
      current = [reading]
      currentSign = null
    }
  }

  if (current.length > 0) {
    threads.push({ direction: currentSign === null ? null : currentSign === 1 ? 'ascending' : 'descending', readings: current })
  }

  return threads
}
