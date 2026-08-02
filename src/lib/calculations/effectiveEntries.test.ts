import { describe, expect, it } from 'vitest'
import { filterEffective, isEffective, type EffectiveEntryInput } from './effectiveEntries'

describe('isEffective', () => {
  it('a confirmed entry with no successor is effective', () => {
    const a: EffectiveEntryInput = { id: 'a', status: 'confirmed', supersedes: null }
    expect(isEffective(a, [a])).toBe(true)
  })

  it('a draft entry is never effective, even with no successor', () => {
    const a: EffectiveEntryInput = { id: 'a', status: 'draft', supersedes: null }
    expect(isEffective(a, [a])).toBe(false)
  })

  it('the original stays effective while its correction is still draft — the whole point of the rule', () => {
    const original: EffectiveEntryInput = { id: 'a', status: 'confirmed', supersedes: null }
    const correction: EffectiveEntryInput = { id: 'b', status: 'draft', supersedes: 'a' }
    const all = [original, correction]
    expect(isEffective(original, all)).toBe(true)
    expect(isEffective(correction, all)).toBe(false)
  })

  it('the original drops out only once its correction is confirmed', () => {
    const original: EffectiveEntryInput = { id: 'a', status: 'confirmed', supersedes: null }
    const correction: EffectiveEntryInput = { id: 'b', status: 'confirmed', supersedes: 'a' }
    const all = [original, correction]
    expect(isEffective(original, all)).toBe(false)
    expect(isEffective(correction, all)).toBe(true)
  })

  it('a chain: middle entry stays effective while its correction is still draft', () => {
    const a: EffectiveEntryInput = { id: 'a', status: 'confirmed', supersedes: null }
    const b: EffectiveEntryInput = { id: 'b', status: 'confirmed', supersedes: 'a' }
    const c: EffectiveEntryInput = { id: 'c', status: 'draft', supersedes: 'b' }
    const all = [a, b, c]
    expect(isEffective(a, all)).toBe(false) // superseded by confirmed b
    expect(isEffective(b, all)).toBe(true) // c hasn't been confirmed yet
    expect(isEffective(c, all)).toBe(false) // draft
  })
})

describe('filterEffective', () => {
  it('returns only the effective rows from a mixed set', () => {
    const untouched: EffectiveEntryInput = { id: 'x', status: 'confirmed', supersedes: null }
    const original: EffectiveEntryInput = { id: 'a', status: 'confirmed', supersedes: null }
    const correction: EffectiveEntryInput = { id: 'b', status: 'confirmed', supersedes: 'a' }
    const stray: EffectiveEntryInput = { id: 'y', status: 'draft', supersedes: null }
    const result = filterEffective([untouched, original, correction, stray])
    expect(result.map((e) => e.id).sort()).toEqual(['b', 'x'])
  })

  it('returns an empty array for an empty input', () => {
    expect(filterEffective([])).toEqual([])
  })
})
