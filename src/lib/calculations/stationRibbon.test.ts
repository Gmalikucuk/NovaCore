import { describe, expect, it } from 'vitest'
import { axisPercent, axisRange, axisTicks, barSpan, groupBySegment, sortSegments } from './stationRibbon'

describe('barSpan', () => {
  it('an ascending record spans from station_from to station_to', () => {
    expect(barSpan({ stationFrom: 12.4, stationTo: 13.48 })).toEqual({ left: 12.4, right: 13.48, isPoint: false })
  })

  it('a descending record (stations count down against travel) still spans the lesser to the greater value', () => {
    // Venables paved 10+725 to 9+175 southbound — station_from > station_to on the record itself.
    expect(barSpan({ stationFrom: 10.725, stationTo: 9.175 })).toEqual({ left: 9.175, right: 10.725, isPoint: false })
  })

  it('a null station_to is a point, not a zero-width span', () => {
    expect(barSpan({ stationFrom: 12.38, stationTo: null })).toEqual({ left: 12.38, right: 12.38, isPoint: true })
  })

  it('the Venables milling/paving case: milling 6+110-3+420, paving 6+110-3+210, both descending', () => {
    const milling = barSpan({ stationFrom: 6.11, stationTo: 3.42 })
    const paving = barSpan({ stationFrom: 6.11, stationTo: 3.21 })
    expect(milling).toEqual({ left: 3.42, right: 6.11, isPoint: false })
    expect(paving).toEqual({ left: 3.21, right: 6.11, isPoint: false })
    // Paving's far edge sits 210 m past milling's — the real, reported gap.
    expect(Math.round((milling.left - paving.left) * 1000)).toBe(210)
  })
})

describe('groupBySegment', () => {
  it('groups records by lki_segment, including a null group for unrecorded segments', () => {
    const records = [
      { id: 'a', lkiSegment: 2090 },
      { id: 'b', lkiSegment: 2091 },
      { id: 'c', lkiSegment: 2090 },
      { id: 'd', lkiSegment: null },
    ]
    const grouped = groupBySegment(records)
    expect(grouped.get(2090)?.map((r) => r.id)).toEqual(['a', 'c'])
    expect(grouped.get(2091)?.map((r) => r.id)).toEqual(['b'])
    expect(grouped.get(null)?.map((r) => r.id)).toEqual(['d'])
  })
})

describe('sortSegments', () => {
  it('sorts numbered segments ascending, with the null (unrecorded) group last', () => {
    expect(sortSegments([2091, null, 2090])).toEqual([2090, 2091, null])
  })

  it('is stable when there is only a null group', () => {
    expect(sortSegments([null])).toEqual([null])
  })
})

describe('axisRange', () => {
  it('is null for an empty record set — nothing to draw, nothing to measure', () => {
    expect(axisRange([])).toBeNull()
  })

  it('rounds outward to a tenth and widens a degenerate (near-zero) span to a visible minimum', () => {
    const range = axisRange([{ stationFrom: 12.38, stationTo: null }])
    expect(range).not.toBeNull()
    expect(range!.hi - range!.lo).toBeCloseTo(0.2, 5)
  })

  it('spans every record handed in, using each record\'s own min/max — real Hwy 97C fixture (Cold Mill vs Top Lift vs Level Course), ceiled outward to the nearest tenth', () => {
    const records = [
      { stationFrom: 12.4, stationTo: 14.42 }, // Cold Mill 50mm, contiguous run
      { stationFrom: 12.4, stationTo: 14.02 }, // Top Lift, falls short
      { stationFrom: 12.4, stationTo: 13.79 }, // Level Course, falls further short
    ]
    const range = axisRange(records)
    expect(range).toEqual({ lo: 12.4, hi: 14.5 })
  })
})

describe('axisTicks', () => {
  it('uses a finer step for a short span', () => {
    const ticks = axisTicks({ lo: 12.4, hi: 12.9 })
    expect(ticks[1] - ticks[0]).toBeCloseTo(0.1, 5)
  })

  it('uses a coarser step for a long span', () => {
    const ticks = axisTicks({ lo: 0, hi: 24 })
    expect(ticks[1] - ticks[0]).toBeCloseTo(2, 5)
  })

  it('never produces a tick past the axis range', () => {
    const range = { lo: 12.4, hi: 14.42 }
    const ticks = axisTicks(range)
    expect(ticks.every((t) => t <= range.hi + 1e-9)).toBe(true)
    expect(ticks.every((t) => t >= range.lo)).toBe(true)
  })
})

describe('axisPercent', () => {
  it('maps the low end to 0% and the high end to 100%', () => {
    const range = { lo: 10, hi: 20 }
    expect(axisPercent(range, 10)).toBe(0)
    expect(axisPercent(range, 20)).toBe(100)
    expect(axisPercent(range, 15)).toBe(50)
  })
})
