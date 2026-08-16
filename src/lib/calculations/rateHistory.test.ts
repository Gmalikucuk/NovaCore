import { describe, expect, it } from 'vitest'
import { asOfDate, asOfYear, currentByDate, currentByYear } from './rateHistory'

describe('currentByYear', () => {
  it('picks the latest bookYear', () => {
    const rows = [{ bookYear: 2024, v: 'a' }, { bookYear: 2026, v: 'b' }, { bookYear: 2025, v: 'c' }]
    expect(currentByYear(rows)?.v).toBe('b')
  })

  it('is null for an empty array', () => {
    expect(currentByYear([])).toBeNull()
  })
})

describe('asOfYear', () => {
  const rows = [{ bookYear: 2024, v: 'a' }, { bookYear: 2026, v: 'b' }]

  it('resolves to the latest row at or before the given year', () => {
    expect(asOfYear(rows, 2025)?.v).toBe('a')
  })

  it('resolves exactly on a matching year', () => {
    expect(asOfYear(rows, 2026)?.v).toBe('b')
  })

  it('never returns a future row', () => {
    expect(asOfYear(rows, 2023)).toBeNull()
  })
})

describe('currentByDate', () => {
  it('picks the latest effectiveDate', () => {
    const rows = [{ effectiveDate: '2024-01-01', v: 'a' }, { effectiveDate: '2026-01-01', v: 'b' }]
    expect(currentByDate(rows)?.v).toBe('b')
  })

  it('is null for an empty array', () => {
    expect(currentByDate([])).toBeNull()
  })
})

describe('asOfDate', () => {
  // The exact case the brief itself raised: a bid priced in 2024 must
  // read 2024's rate, never a later correction.
  const rows = [{ effectiveDate: '2024-01-01', v: 42 }, { effectiveDate: '2026-01-01', v: 45.5 }]

  it('resolves a mid-period date to the earlier still-effective row', () => {
    expect(asOfDate(rows, '2025-06-01')?.v).toBe(42)
  })

  it('resolves exactly on a matching effective date', () => {
    expect(asOfDate(rows, '2026-01-01')?.v).toBe(45.5)
  })

  it('never returns a row effective after the asked-for date', () => {
    expect(asOfDate(rows, '2023-12-31')).toBeNull()
  })
})
