import type { Segment } from './segmentArea'
import { cumulativeArea } from './segmentArea'

export interface TruckTicket {
  vehicleNumber: string
  ticketNumber: string
  tonnage: number
  /** physical arrival order — process in this order */
  arrivalSequence: number
  liftType: 'top_lift' | 'level_course'
}

export interface TruckOutput {
  vehicleNumber: string
  ticketNumber: string
  tonnageCurrent: number
  tonnageCumulative: number
  /** null for level_course */
  fromStation: number | null
  toStation: number | null
  length: number | null
  avgWidth: number | null
  area: number | null
  rateKgM2: number | null
  ratePct: number | null
  comment: string | null
}

export interface SeedInput {
  date: string
  roadSegmentId: string
}

export interface WaveConfig {
  /** percentage points, e.g. 0.18 for 0.18% */
  amplitudePct: number
  /** percentage points, e.g. 0.03 for 0.03% */
  noisePct: number
  periodTrucks: number
}

/** Below this, a quadratic coefficient is treated as zero (uniform width within the segment) to avoid dividing by ~0. */
const QUADRATIC_A_EPSILON = 1e-9
/** Area/tolerance floor for the segment walk — negligible relative to realistic m² magnitudes, but comfortably above float noise. */
const AREA_EPSILON = 1e-6
/** A discriminant below -this is treated as a genuine infeasibility, not floating-point noise — see solveQuadraticPosition. */
const DISCRIMINANT_EPSILON = 1e-6

// FNV-1a — a simple, well-known non-cryptographic string hash. Only used to
// turn (date, roadSegmentId) into a numeric seed; never real randomness.
function hashStringToSeed(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

// mulberry32 — a small, deterministic, seedable PRNG. Same seed always
// produces the same sequence.
function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Solves a*s^2 + b*s - c = 0 for the increasing-distance root. Falls back to
 * the linear case (c/b) when a segment's width doesn't vary (a ~ 0), since
 * the quadratic formula would otherwise divide by ~0.
 *
 * A discriminant that's negative beyond floating-point noise means there is
 * no real solution — the target area c is mathematically unreachable within
 * this segment (e.g. width would have to go negative to get there). In
 * correct operation the caller (the segment walk) never asks for more area
 * than a segment can actually provide, so a genuine negative here means the
 * walk's own remaining-area bookkeeping is wrong, not a rounding artifact.
 * Throwing surfaces that bug immediately instead of silently returning a
 * plausible-looking but wrong station (sqrt(0) would otherwise happily
 * return 0 and mask it).
 */
export function solveQuadraticPosition(
  a: number,
  b: number,
  c: number,
  context: { fromStation: number; toStation: number },
): number {
  if (Math.abs(a) < QUADRATIC_A_EPSILON) {
    return c / b
  }
  const discriminant = b * b + 4 * a * c
  if (discriminant < -DISCRIMINANT_EPSILON) {
    throw new Error(
      `Unreachable target area in segment solve: discriminant ${discriminant} — this indicates the segment-walking logic passed an infeasible target to the quadratic solver, not a floating-point rounding issue. Segment: [${context.fromStation} -> ${context.toStation}], target area: ${c}.`,
    )
  }
  return (-b + Math.sqrt(Math.max(discriminant, 0))) / (2 * a)
}

interface PartialOutput {
  vehicleNumber: string
  ticketNumber: string
  tonnageCurrent: number
  fromStation: number | null
  toStation: number | null
  length: number | null
  avgWidth: number | null
  area: number | null
  rateKgM2: number | null
  ratePct: number | null
  comment: string | null
}

/**
 * Walks `segments` in array order, assigning each top-lift truck (already in
 * arrivalSequence order) a contiguous station range whose coverage area
 * equals its finalArea. Width varies linearly within a segment (trapezoidal),
 * so finding the station partway through a segment is a quadratic solve, not
 * a division by average width — dividing by average width is exactly the
 * length x width error this is built to avoid.
 *
 * Zero-length rollover-boundary segments are skipped entirely (they
 * contribute no area to consume). A truck's assigned range can legitimately
 * span across one of these — its own reported length is accumulated as
 * physical distance actually walked, not derived from
 * |toStation - fromStation| after the fact. For a normal (non-rollover-
 * spanning) truck these are numerically identical; only diverges when a
 * rollover is crossed, where the naive station difference would otherwise
 * be a nonsensical multi-thousand-metre number.
 */
function walkSegmentsForTrucks(
  segments: Segment[],
  topLiftTrucks: TruckTicket[],
  finalAreas: number[],
  targetRateKgM2: number,
): PartialOutput[] {
  let segIdx = 0
  let posInSeg = 0

  const stationAt = (idx: number, pos: number): number => {
    const seg = segments[idx]
    if (seg.length === 0) return seg.fromStation
    const direction = (seg.toStation - seg.fromStation) / seg.length
    return seg.fromStation + direction * pos
  }

  const areaFromPosToEnd = (idx: number, pos: number): number => {
    const seg = segments[idx]
    if (seg.length === 0) return 0
    const a = (seg.toWidth - seg.fromWidth) / (2 * seg.length)
    const b = seg.fromWidth
    const areaAtLength = a * seg.length * seg.length + b * seg.length
    const areaAtPos = a * pos * pos + b * pos
    return areaAtLength - areaAtPos
  }

  const outputs: PartialOutput[] = []

  for (let t = 0; t < topLiftTrucks.length; t++) {
    const truck = topLiftTrucks[t]
    let remaining = finalAreas[t]
    const fromStation = stationAt(segIdx, posInSeg)
    let physicalLength = 0

    while (remaining > AREA_EPSILON && segIdx < segments.length) {
      const seg = segments[segIdx]
      if (seg.length === 0) {
        segIdx += 1
        posInSeg = 0
        continue
      }

      const available = areaFromPosToEnd(segIdx, posInSeg)
      if (remaining <= available + AREA_EPSILON) {
        const a = (seg.toWidth - seg.fromWidth) / (2 * seg.length)
        const b = seg.fromWidth
        const areaAtPos = a * posInSeg * posInSeg + b * posInSeg
        const newPos = Math.min(
          solveQuadraticPosition(a, b, areaAtPos + remaining, {
            fromStation: seg.fromStation,
            toStation: seg.toStation,
          }),
          seg.length,
        )
        physicalLength += newPos - posInSeg
        posInSeg = newPos
        remaining = 0
      } else {
        physicalLength += seg.length - posInSeg
        remaining -= available
        segIdx += 1
        posInSeg = 0
      }
    }

    const toStation = stationAt(segIdx, posInSeg)
    const area = finalAreas[t]
    const rateKgM2 = (truck.tonnage * 1000) / area
    const ratePct = (rateKgM2 / targetRateKgM2) * 100

    outputs.push({
      vehicleNumber: truck.vehicleNumber,
      ticketNumber: truck.ticketNumber,
      tonnageCurrent: truck.tonnage,
      fromStation,
      toStation,
      length: physicalLength,
      avgWidth: area / physicalLength,
      area,
      rateKgM2,
      ratePct,
      comment: null,
    })
  }

  // Snap the last truck's endpoint to the last real segment's own toStation,
  // eliminating floating-point drift accumulated across many quadratic
  // solves so contiguity with the segment list's true end is exact, not
  // merely close.
  if (outputs.length > 0) {
    const lastRealSegment = [...segments].reverse().find((s) => s.length > 0)
    if (lastRealSegment) {
      const last = outputs[outputs.length - 1]
      last.toStation = lastRealSegment.toStation
      last.length = Math.abs(last.toStation - last.fromStation!)
      last.avgWidth = last.area! / last.length
    }
  }

  return outputs
}

export function reconstructDay(
  segments: Segment[],
  trucks: TruckTicket[],
  targetRateKgM2: number,
  seedInput: SeedInput,
  waveConfig: WaveConfig,
): TruckOutput[] {
  const topLiftTrucks = trucks
    .filter((t) => t.liftType === 'top_lift')
    .slice()
    .sort((a, b) => a.arrivalSequence - b.arrivalSequence)
  const levelCourseTrucks = trucks
    .filter((t) => t.liftType === 'level_course')
    .slice()
    .sort((a, b) => a.arrivalSequence - b.arrivalSequence)

  const totalArea = cumulativeArea(segments)
  const totalTonnage = topLiftTrucks.reduce((sum, t) => sum + t.tonnage, 0)
  const blendedRate = totalTonnage / totalArea

  const naiveAreaShares = topLiftTrucks.map((t) => t.tonnage / blendedRate)

  // Deterministic seed from date + roadSegmentId only — never real
  // randomness. Re-running with identical inputs reproduces the exact same
  // wave, hence byte-identical output. A different roadSegmentId (or date)
  // naturally produces a different wave and different underlying numbers —
  // expected, since a day's reconstruction is one coherent recompute, not a
  // patch to individual rows.
  const seed = hashStringToSeed(`${seedInput.date}:${seedInput.roadSegmentId}`)
  const rng = mulberry32(seed)
  const phase = rng() * 2 * Math.PI

  const amplitudeFraction = waveConfig.amplitudePct / 100
  const noiseFraction = waveConfig.noisePct / 100

  const rawOffsets = topLiftTrucks.map((_, i) => {
    const wave = amplitudeFraction * Math.sin((2 * Math.PI * i) / waveConfig.periodTrucks + phase)
    const noise = (rng() * 2 - 1) * noiseFraction
    return wave + noise
  })

  // Tonnage-weight-normalize so sum(tonnage_i * offset_i) === 0: the wave
  // redistributes area among trucks without shifting the overall blended
  // rate.
  const weightedMean =
    totalTonnage === 0
      ? 0
      : topLiftTrucks.reduce((sum, t, i) => sum + t.tonnage * rawOffsets[i], 0) / totalTonnage
  const offsets = rawOffsets.map((o) => o - weightedMean)

  const adjustedAreas = naiveAreaShares.map((share, i) => share / (1 + offsets[i]))
  const sumAdjusted = adjustedAreas.reduce((sum, a) => sum + a, 0)
  const residual = totalArea - sumAdjusted

  // Distributing the residual proportionally to adjustedArea makes
  // sum(finalArea) === totalArea exactly, not just approximately — this is
  // what makes the blended rate mathematically exact.
  const finalAreas = adjustedAreas.map((a) => a + residual * (a / sumAdjusted))

  const topLiftOutputs = walkSegmentsForTrucks(segments, topLiftTrucks, finalAreas, targetRateKgM2)

  const levelCourseOutputs: PartialOutput[] = levelCourseTrucks.map((t) => ({
    vehicleNumber: t.vehicleNumber,
    ticketNumber: t.ticketNumber,
    tonnageCurrent: t.tonnage,
    fromStation: null,
    toStation: null,
    length: null,
    avgWidth: null,
    area: null,
    rateKgM2: null,
    ratePct: null,
    comment: 'Level Course',
  }))

  const outputByTruck = new Map<TruckTicket, PartialOutput>()
  topLiftTrucks.forEach((truck, i) => outputByTruck.set(truck, topLiftOutputs[i]))
  levelCourseTrucks.forEach((truck, i) => outputByTruck.set(truck, levelCourseOutputs[i]))

  const byArrival = [...trucks].sort((a, b) => a.arrivalSequence - b.arrivalSequence)
  let runningTonnage = 0
  return byArrival.map((truck) => {
    runningTonnage += truck.tonnage
    const partial = outputByTruck.get(truck)!
    return { ...partial, tonnageCumulative: runningTonnage }
  })
}
