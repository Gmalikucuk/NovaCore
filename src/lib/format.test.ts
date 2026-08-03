import { describe, expect, it } from 'vitest'
import { money, parseStation, percent, quantity, rate, station, stationDecimal } from './format'

describe('quantity', () => {
  it('drops a bare .0', () => {
    expect(quantity(21400)).toBe('21,400')
  })
  it('keeps a real fraction', () => {
    expect(quantity(21400.5)).toBe('21,400.5')
  })
  it('appends the unit when given', () => {
    expect(quantity(7400, 'Litre')).toBe('7,400 Litre')
  })
  it('renders null/undefined as an em dash', () => {
    expect(quantity(null)).toBe('—')
    expect(quantity(undefined)).toBe('—')
  })
})

describe('money', () => {
  it('drops decimals at or above $1,000', () => {
    expect(money(268793)).toBe('$268,793')
    expect(money(1000)).toBe('$1,000')
  })
  it('keeps two decimals below $1,000', () => {
    expect(money(500.25)).toBe('$500.25')
  })
  it('puts the sign before the dollar sign', () => {
    expect(money(-1234)).toBe('-$1,234')
  })
  it('renders null as an em dash, not $0', () => {
    expect(money(null)).toBe('—')
  })
})

describe('rate', () => {
  it('always shows two decimals, however small', () => {
    expect(rate(29.85)).toBe('$29.85')
    expect(rate(1.94)).toBe('$1.94')
    expect(rate(2)).toBe('$2.00')
  })
  it('is not dropped to zero decimals above $1,000 the way money() would', () => {
    expect(rate(1500)).toBe('$1,500.00')
  })
})

describe('percent', () => {
  it('formats a 0-1 ratio to one decimal', () => {
    expect(percent(1.03)).toBe('103.0%')
    expect(percent(0)).toBe('0.0%')
  })
  it('renders null as an em dash', () => {
    expect(percent(null)).toBe('—')
  })
})

describe('stationDecimal', () => {
  it('defaults to three decimals, no thousands separator', () => {
    expect(stationDecimal(12500.5)).toBe('12500.500')
  })
  it('accepts a narrower digit count for compressed axis labels', () => {
    expect(stationDecimal(12500.5, 0)).toBe('12501')
    expect(stationDecimal(12500.5, 1)).toBe('12500.5')
  })
  it('renders null as an em dash', () => {
    expect(stationDecimal(null)).toBe('—')
  })
})

describe('station', () => {
  it('formats whole km, +, three-digit metres', () => {
    expect(station(19.385)).toBe('19+385')
  })
  it('pads metres under 100', () => {
    expect(station(4.007)).toBe('4+007')
  })
  it('applies the same notation to a reach (a length, not just a point)', () => {
    expect(station(0.51)).toBe('0+510')
  })
  it('carries a rounding-up metres value into the next km', () => {
    expect(station(12.9996)).toBe('13+000')
  })
  it('renders null/undefined as an em dash', () => {
    expect(station(null)).toBe('—')
    expect(station(undefined)).toBe('—')
  })
})

describe('parseStation', () => {
  it('parses the + notation', () => {
    expect(parseStation('19+385')).toBeCloseTo(19.385, 6)
  })
  it('parses a plain decimal km', () => {
    expect(parseStation('19.385')).toBeCloseTo(19.385, 6)
  })
  it('parses both forms to the same stored value', () => {
    expect(parseStation('4+007')).toBeCloseTo(parseStation('4.007') as number, 6)
  })
  it('returns null for an empty or unparseable input', () => {
    expect(parseStation('')).toBeNull()
    expect(parseStation('abc')).toBeNull()
    expect(parseStation('12+abc')).toBeNull()
  })
})
