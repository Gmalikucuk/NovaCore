import { describe, expect, it } from 'vitest'
import { splitIntoThreads } from './sessionThreads'

describe('splitIntoThreads', () => {
  it('returns nothing for no readings', () => {
    expect(splitIntoThreads([])).toEqual([])
  })

  it('a single reading has no direction to infer', () => {
    expect(splitIntoThreads([{ station: 100 }])).toEqual([{ direction: null, readings: [{ station: 100 }] }])
  })

  it('a consistently increasing run is one ascending thread', () => {
    const readings = [{ station: 0 }, { station: 50 }, { station: 100 }]
    expect(splitIntoThreads(readings)).toEqual([{ direction: 'ascending', readings }])
  })

  it('a consistently decreasing run is one descending thread', () => {
    const readings = [{ station: 100 }, { station: 50 }, { station: 0 }]
    expect(splitIntoThreads(readings)).toEqual([{ direction: 'descending', readings }])
  })

  it('splits into a new thread exactly where the station delta reverses sign', () => {
    const readings = [{ station: 0 }, { station: 50 }, { station: 100 }, { station: 400 }, { station: 350 }]
    expect(splitIntoThreads(readings)).toEqual([
      { direction: 'ascending', readings: [{ station: 0 }, { station: 50 }, { station: 100 }, { station: 400 }] },
      { direction: null, readings: [{ station: 350 }] },
    ])
  })

  it('a later reading continuing the reversal completes the new thread\'s direction', () => {
    const readings = [{ station: 0 }, { station: 50 }, { station: 100 }, { station: 400 }, { station: 350 }, { station: 300 }]
    expect(splitIntoThreads(readings)).toEqual([
      { direction: 'ascending', readings: [{ station: 0 }, { station: 50 }, { station: 100 }, { station: 400 }] },
      { direction: 'descending', readings: [{ station: 350 }, { station: 300 }] },
    ])
  })

  it('a repeated (zero-delta) station stays in the current thread without resetting direction', () => {
    const readings = [{ station: 0 }, { station: 50 }, { station: 50 }, { station: 100 }]
    expect(splitIntoThreads(readings)).toEqual([{ direction: 'ascending', readings }])
  })

  it('a lone reading followed by a directional run keeps the lone reading in the first thread', () => {
    const readings = [{ station: 200 }, { station: 250 }, { station: 300 }]
    expect(splitIntoThreads(readings)).toEqual([{ direction: 'ascending', readings }])
  })
})
