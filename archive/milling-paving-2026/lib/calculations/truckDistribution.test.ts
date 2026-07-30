import { describe, expect, it } from 'vitest'
import { calculateSegments, cumulativeArea, type Segment } from './segmentArea'
import { reconstructDay, solveQuadraticPosition, type TruckTicket } from './truckDistribution'

// Multi-segment fixture: 0->250->600->1000, widths 4.0/4.2/3.8/4.0.
// totalArea = 1025 + 1400 + 1560 = 3985 m^2.
function buildMainFixtureSegments(): Segment[] {
  return calculateSegments([
    { stationSequence: 1, station: 0, width: 4.0 },
    { stationSequence: 2, station: 250, width: 4.2 },
    { stationSequence: 3, station: 600, width: 3.8 },
    { stationSequence: 4, station: 1000, width: 4.0 },
  ])
}

// 8 top-lift trucks (totalTonnage 183.3t) with 3 level-course trucks
// interspersed at arrivalSequence 3, 6, 9.
function buildMainFixtureTrucks(): TruckTicket[] {
  return [
    { vehicleNumber: 'V-T1', ticketNumber: 'TK-T1', tonnage: 22.5, arrivalSequence: 1, liftType: 'top_lift' },
    { vehicleNumber: 'V-T2', ticketNumber: 'TK-T2', tonnage: 23.1, arrivalSequence: 2, liftType: 'top_lift' },
    { vehicleNumber: 'V-L1', ticketNumber: 'TK-L1', tonnage: 18.0, arrivalSequence: 3, liftType: 'level_course' },
    { vehicleNumber: 'V-T3', ticketNumber: 'TK-T3', tonnage: 21.8, arrivalSequence: 4, liftType: 'top_lift' },
    { vehicleNumber: 'V-T4', ticketNumber: 'TK-T4', tonnage: 24.0, arrivalSequence: 5, liftType: 'top_lift' },
    { vehicleNumber: 'V-L2', ticketNumber: 'TK-L2', tonnage: 19.5, arrivalSequence: 6, liftType: 'level_course' },
    { vehicleNumber: 'V-T5', ticketNumber: 'TK-T5', tonnage: 22.9, arrivalSequence: 7, liftType: 'top_lift' },
    { vehicleNumber: 'V-T6', ticketNumber: 'TK-T6', tonnage: 23.5, arrivalSequence: 8, liftType: 'top_lift' },
    { vehicleNumber: 'V-L3', ticketNumber: 'TK-L3', tonnage: 17.2, arrivalSequence: 9, liftType: 'level_course' },
    { vehicleNumber: 'V-T7', ticketNumber: 'TK-T7', tonnage: 21.2, arrivalSequence: 10, liftType: 'top_lift' },
    { vehicleNumber: 'V-T8', ticketNumber: 'TK-T8', tonnage: 24.3, arrivalSequence: 11, liftType: 'top_lift' },
  ]
}

// Same trucks, deliberately out of arrivalSequence order — proves
// reconstructDay sorts internally rather than trusting input order.
function shuffledMainFixtureTrucks(): TruckTicket[] {
  const trucks = buildMainFixtureTrucks()
  const order = [7, 2, 0, 9, 4, 1, 10, 3, 8, 6, 5]
  return order.map((i) => trucks[i])
}

function targetRateFor(segments: Segment[], trucks: TruckTicket[]): number {
  const totalArea = cumulativeArea(segments)
  const totalTonnage = trucks
    .filter((t) => t.liftType === 'top_lift')
    .reduce((sum, t) => sum + t.tonnage, 0)
  // Set target == blended rate exactly, so blendedRate's ratePct is exactly
  // 100 — makes the wave-bound test (test 4) a clean check against a known
  // percentage rather than an arbitrary one.
  return (totalTonnage * 1000) / totalArea
}

const NO_WAVE = { amplitudePct: 0, noisePct: 0, periodTrucks: 5 }
const REALISTIC_WAVE = { amplitudePct: 0.18, noisePct: 0.03, periodTrucks: 5 }
const SEED = { date: '2026-07-06', roadSegmentId: 'seg-main-fixture' }

function topLiftOf(outputs: ReturnType<typeof reconstructDay>) {
  return outputs.filter((o) => o.comment === null)
}

describe('reconstructDay', () => {
  it('1. sum of all top-lift finalArea exactly equals totalArea', () => {
    const segments = buildMainFixtureSegments()
    const trucks = buildMainFixtureTrucks()
    const targetRateKgM2 = targetRateFor(segments, trucks)

    const outputs = reconstructDay(segments, trucks, targetRateKgM2, SEED, REALISTIC_WAVE)
    const totalArea = cumulativeArea(segments)
    const sumOfAreas = topLiftOf(outputs).reduce((sum, o) => sum + o.area!, 0)

    expect(sumOfAreas).toBeCloseTo(totalArea, 8)
  })

  it('2. recomputed blended rate (sum tonnage / sum area) matches the original', () => {
    const segments = buildMainFixtureSegments()
    const trucks = buildMainFixtureTrucks()
    const targetRateKgM2 = targetRateFor(segments, trucks)
    const totalArea = cumulativeArea(segments)
    const totalTonnage = trucks
      .filter((t) => t.liftType === 'top_lift')
      .reduce((sum, t) => sum + t.tonnage, 0)
    const originalBlendedRate = totalTonnage / totalArea

    const outputs = reconstructDay(segments, trucks, targetRateKgM2, SEED, REALISTIC_WAVE)
    const topLift = topLiftOf(outputs)
    const recomputedBlendedRate =
      topLift.reduce((sum, o) => sum + o.tonnageCurrent, 0) / topLift.reduce((sum, o) => sum + o.area!, 0)

    expect(recomputedBlendedRate).toBeCloseTo(originalBlendedRate, 10)
  })

  it('3. top-lift station ranges are contiguous, spanning the full segment list', () => {
    const segments = buildMainFixtureSegments()
    const trucks = shuffledMainFixtureTrucks()
    const targetRateKgM2 = targetRateFor(segments, trucks)

    const outputs = reconstructDay(segments, trucks, targetRateKgM2, SEED, REALISTIC_WAVE)
    const topLift = topLiftOf(outputs)

    expect(topLift[0].fromStation).toBeCloseTo(segments[0].fromStation, 9)
    expect(topLift[topLift.length - 1].toStation).toBeCloseTo(
      segments[segments.length - 1].toStation,
      9,
    )
    for (let i = 0; i < topLift.length - 1; i++) {
      expect(topLift[i + 1].fromStation).toBeCloseTo(topLift[i].toStation!, 9)
    }
  })

  it('4. with realistic wave (0.18%/0.03%), every ratePct falls within blendedRatePct +/- (amplitude + noise)', () => {
    const segments = buildMainFixtureSegments()
    const trucks = buildMainFixtureTrucks()
    const targetRateKgM2 = targetRateFor(segments, trucks) // blendedRatePct == 100 exactly

    const outputs = reconstructDay(segments, trucks, targetRateKgM2, SEED, REALISTIC_WAVE)
    const bound = REALISTIC_WAVE.amplitudePct + REALISTIC_WAVE.noisePct
    // Small buffer for the second-order effect of residual redistribution
    // (step 9) on top of the wave offset itself — the offsets are tiny
    // (~0.2%), so this effect is tiny too.
    const buffer = 0.05

    for (const output of topLiftOf(outputs)) {
      expect(output.ratePct).toBeGreaterThanOrEqual(100 - bound - buffer)
      expect(output.ratePct).toBeLessThanOrEqual(100 + bound + buffer)
    }
  })

  it('5. with wave amplitude and noise at 0, every truck ratePct exactly equals the blended rate', () => {
    const segments = buildMainFixtureSegments()
    const trucks = buildMainFixtureTrucks()
    const targetRateKgM2 = targetRateFor(segments, trucks)

    const outputs = reconstructDay(segments, trucks, targetRateKgM2, SEED, NO_WAVE)

    for (const output of topLiftOf(outputs)) {
      expect(output.ratePct).toBeCloseTo(100, 8)
    }
  })

  it('6. level-course trucks have null coverage fields and do not consume segment area', () => {
    const segments = buildMainFixtureSegments()
    const trucks = buildMainFixtureTrucks()
    const targetRateKgM2 = targetRateFor(segments, trucks)
    const totalArea = cumulativeArea(segments)

    const outputs = reconstructDay(segments, trucks, targetRateKgM2, SEED, REALISTIC_WAVE)
    const levelCourse = outputs.filter((o) => o.comment === 'Level Course')

    expect(levelCourse).toHaveLength(3)
    for (const output of levelCourse) {
      expect(output.fromStation).toBeNull()
      expect(output.toStation).toBeNull()
      expect(output.length).toBeNull()
      expect(output.avgWidth).toBeNull()
      expect(output.area).toBeNull()
      expect(output.rateKgM2).toBeNull()
      expect(output.ratePct).toBeNull()
    }

    // Top-lift trucks' total area is unaffected by the interspersed
    // level-course trucks — still exactly totalArea.
    const sumOfTopLiftArea = topLiftOf(outputs).reduce((sum, o) => sum + o.area!, 0)
    expect(sumOfTopLiftArea).toBeCloseTo(totalArea, 8)
  })

  it('7. a truck spanning the rollover boundary gets sensible fromStation/toStation', () => {
    // Same rollover pattern as segmentArea.test.ts's cumulativeArea test:
    // ascends near 45+060, rolls over to 0+000, continues ascending.
    // totalArea = 80 + 150 + 60 + 0 + 160 + 270 = 720.
    const segments = calculateSegments([
      { stationSequence: 1, station: 45000, width: 4 },
      { stationSequence: 2, station: 45020, width: 4 }, // seg1: len20 area80
      { stationSequence: 3, station: 45050, width: 6 }, // seg2: len30 avgWidth5 area150
      { stationSequence: 4, station: 45060, width: 6 }, // seg3: len10 area60
      { stationSequence: 5, station: 20, width: 8 }, // seg4: rollover, area0
      { stationSequence: 6, station: 40, width: 8 }, // seg5: len20 area160
      { stationSequence: 7, station: 70, width: 10 }, // seg6: len30 avgWidth9 area270
    ])
    const totalArea = cumulativeArea(segments)
    expect(totalArea).toBeCloseTo(720, 9)

    // Desired area shares 250 / 190 / 280 (sums to 720). With NO_WAVE,
    // finalArea exactly equals tonnage/blendedRate, so picking tonnages
    // proportional to the desired shares (any constant rate) reproduces
    // that exact split — this lets the test target the rollover boundary
    // precisely instead of leaving it to chance.
    const rate = 0.05 // tonnes/m^2, arbitrary
    const trucks: TruckTicket[] = [
      { vehicleNumber: 'V1', ticketNumber: 'T1', tonnage: 250 * rate, arrivalSequence: 1, liftType: 'top_lift' },
      { vehicleNumber: 'V2', ticketNumber: 'T2', tonnage: 190 * rate, arrivalSequence: 2, liftType: 'top_lift' },
      { vehicleNumber: 'V3', ticketNumber: 'T3', tonnage: 280 * rate, arrivalSequence: 3, liftType: 'top_lift' },
    ]
    const targetRateKgM2 = targetRateFor(segments, trucks)

    const outputs = reconstructDay(segments, trucks, targetRateKgM2, SEED, NO_WAVE)
    const [truck1, truck2, truck3] = topLiftOf(outputs)

    // truck1: consumes seg1(80)+seg2(150)+20 of seg3(60) -> ends partway
    // through seg3, well before the rollover.
    expect(truck1.fromStation).toBeCloseTo(45000, 6)
    expect(truck1.toStation).toBeCloseTo(45053.333333, 3)

    // truck2: the crossing truck — starts inside seg3 (pre-rollover),
    // consumes the rest of seg3, passes straight through the zero-length
    // rollover segment, and lands partway through seg5 (post-rollover).
    expect(truck2.fromStation).toBeCloseTo(45053.333333, 3)
    expect(truck2.toStation).toBeCloseTo(38.75, 3)
    // "Sensible": a small physical distance, nowhere near the ~45000
    // magnitude a naive |toStation - fromStation| would produce.
    expect(truck2.length).toBeGreaterThan(0)
    expect(truck2.length).toBeLessThan(100)
    expect(truck2.length).toBeCloseTo(6.666667 + 18.75, 3)

    // truck3: picks up from truck2's end, finishes exactly at the last
    // segment's toStation (the explicit end-of-day snap).
    expect(truck3.fromStation).toBeCloseTo(38.75, 3)
    expect(truck3.toStation).toBeCloseTo(70, 9)

    const sumOfAreas = topLiftOf(outputs).reduce((sum, o) => sum + o.area!, 0)
    expect(sumOfAreas).toBeCloseTo(720, 8)
  })

  it('8. determinism: identical inputs reproduce byte-identical output; a different roadSegmentId changes it', () => {
    const segments = buildMainFixtureSegments()
    const trucks = buildMainFixtureTrucks()
    const targetRateKgM2 = targetRateFor(segments, trucks)

    const run1 = reconstructDay(segments, trucks, targetRateKgM2, SEED, REALISTIC_WAVE)
    const run2 = reconstructDay(segments, trucks, targetRateKgM2, SEED, REALISTIC_WAVE)
    expect(run2).toEqual(run1)

    const run3 = reconstructDay(
      segments,
      trucks,
      targetRateKgM2,
      { ...SEED, roadSegmentId: 'a-completely-different-segment-id' },
      REALISTIC_WAVE,
    )
    const anyDifference = run3.some((output, i) => {
      const original = run1[i]
      return output.area !== original.area || output.ratePct !== original.ratePct
    })
    expect(anyDifference).toBe(true)
  })

  it('9. solveQuadraticPosition throws on a genuinely unreachable target, rather than returning a wrong position', () => {
    // width goes 10 -> 2 over length 20: a = (2-10)/(2*20) = -0.2, b = 10.
    // Area(s) = -0.2*s^2 + 10*s is a downward parabola — its maximum
    // possible value, at the vertex (s = -b/2a = 25), is 125. No station
    // (even hypothetically beyond the segment's own length) can ever
    // accumulate more than that. Asking for 150 is mathematically
    // unreachable — this simulates the segment-walking logic handing the
    // solver a target it corrupted, not floating-point noise (the
    // discriminant here is a clean -20, nowhere near the epsilon boundary).
    const a = -0.2
    const b = 10
    const unreachableTarget = 150

    expect(() =>
      solveQuadraticPosition(a, b, unreachableTarget, { fromStation: 100, toStation: 120 }),
    ).toThrow(/Unreachable target area in segment solve/)
  })
})
