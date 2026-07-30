import { describe, expect, it } from 'vitest'
import { resolveSegmentForStation, type SegmentRange } from './segmentResolution'

const segment1: SegmentRange = {
  id: 'seg-1',
  fromStation: 25340,
  toStation: 35235,
  highway2FromStation: null,
  highway2ToStation: null,
}

// Mirrors the real multi-highway shape: primary range on one highway, a
// second continuous run on a different highway captured via highway2.
const segment2: SegmentRange = {
  id: 'seg-2',
  fromStation: 43170,
  toStation: 45060,
  highway2FromStation: 0,
  highway2ToStation: 11225,
}

// A contract-adjacent segment whose station numbers overlap segment2's
// highway2 range even though it's a physically unrelated stretch of road —
// exactly the ambiguous case the sticky-resolution rule exists to avoid.
const segment4: SegmentRange = {
  id: 'seg-4',
  fromStation: 5905,
  toStation: 5990,
  highway2FromStation: null,
  highway2ToStation: null,
}

// SB rows store from/to reversed relative to NB (walked the other way).
const segment1Reversed: SegmentRange = {
  id: 'seg-1-sb',
  fromStation: 35235,
  toStation: 25340,
  highway2FromStation: null,
  highway2ToStation: null,
}

describe('resolveSegmentForStation', () => {
  it('finds the containing segment when nothing is active yet', () => {
    expect(resolveSegmentForStation(30000, [segment1, segment2], null)).toBe(segment1)
  })

  it('returns null when no candidate contains the station', () => {
    expect(resolveSegmentForStation(99999, [segment1, segment2], null)).toBeNull()
  })

  it('matches a highway2 span, not just the primary range', () => {
    expect(resolveSegmentForStation(5950, [segment1, segment2], null)).toBe(segment2)
  })

  it('handles reversed (SB) from/to ordering', () => {
    expect(resolveSegmentForStation(30000, [segment1Reversed], null)).toBe(segment1Reversed)
  })

  it('stays on the active segment when the station still falls within it', () => {
    expect(resolveSegmentForStation(31000, [segment1, segment2], 'seg-1')).toBe(segment1)
  })

  it('prefers the active segment over an ambiguous overlapping candidate', () => {
    // 5950 falls inside BOTH segment2's highway2 span and segment4's primary
    // span. With segment2 active, it must resolve to segment2, not do a
    // blind global lookup that could land on segment4 instead.
    expect(resolveSegmentForStation(5950, [segment2, segment4], 'seg-2')).toBe(segment2)
  })

  it('crosses into a different segment once the station leaves the active one\'s range', () => {
    // Active is segment1 (25340-35235); 43500 is outside that range but
    // inside segment2 (43170-45060) — a real segment-boundary crossing.
    expect(resolveSegmentForStation(43500, [segment1, segment2], 'seg-1')).toBe(segment2)
  })

  it('falls back to a global search when the active segment id has no matching candidate', () => {
    expect(resolveSegmentForStation(30000, [segment1, segment2], 'seg-does-not-exist')).toBe(segment1)
  })
})
