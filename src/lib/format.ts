/**
 * The one place a number becomes display text. Before this, the same value
 * rendered as "21400" (Items), "96500" (Rates), and "21,400.0" (Dashboard) —
 * three formats for one number, plus money showing as both "52,110" and
 * "$268,793" depending on which screen you were on. Nothing in src/ should
 * call toFixed/toLocaleString directly outside this file.
 */

const LOCALE = 'en-CA'

/** Quantity — thousands separators, decimals only when the value actually has them (never a bare ".0"). Appends `unit` when given, for the cells that don't have their own Unit of Measure column. */
export function quantity(n: number | null | undefined, unit?: string): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  const formatted = n.toLocaleString(LOCALE, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
  return unit ? `${formatted} ${unit}` : formatted
}

/** Money — always $, always thousands separators, no decimals at $1,000 or above, two decimals below it (so a rate-sized dollar figure doesn't round away). */
export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  const abs = Math.abs(n)
  const digits = abs < 1000 ? 2 : 0
  const formatted = abs.toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return (n < 0 ? '-$' : '$') + formatted
}

/** A unit price or cost — always two decimals, however small: $29.85, $1.94. Never dropped to $30 by money()'s $1,000 threshold. */
export function rate(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  const abs = Math.abs(n)
  const formatted = abs.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (n < 0 ? '-$' : '$') + formatted
}

/** A 0-1 ratio (percentComplete, marginPercent) as a percentage, one decimal: 103.0%. */
export function percent(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

/** The old fixed-decimal-km display — kept only for ChainageStrip's compressed axis ticks, where `digits` narrows to 0 or 1 for a tight visual scale. Reduced precision has no equivalent in the `+` notation below (metres are always 3 digits), so this stays a plain decimal. Nothing else should call this. */
export function stationDecimal(n: number | null | undefined, digits = 3): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return n.toFixed(digits)
}

/**
 * A station/chainage or reach, in km, as the notation Keywest and the
 * Ministry actually use for distance along a road generally — not only a
 * point on it, which is why a reach (a length) gets the same treatment as a
 * station (a position): whole kilometres, `+`, then metres to three digits.
 * 19.385 -> "19+385".
 */
export function station(km: number | null | undefined): string {
  if (km === null || km === undefined || Number.isNaN(km)) return '—'
  const totalMetres = Math.round(km * 1000)
  const wholeKm = Math.trunc(totalMetres / 1000)
  const metres = Math.abs(totalMetres % 1000)
  return `${wholeKm}+${String(metres).padStart(3, '0')}`
}

/** Accepts either `station()`'s own `+` notation or a plain decimal km ("19+385" or "19.385") and normalises both to the stored km number, so a user typing either form gets the same value. Returns null if neither form parses. */
export function parseStation(input: string): number | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const plusIndex = trimmed.indexOf('+')
  if (plusIndex === -1) {
    const n = Number(trimmed)
    return Number.isNaN(n) ? null : n
  }
  const km = Number(trimmed.slice(0, plusIndex))
  const metres = Number(trimmed.slice(plusIndex + 1))
  if (Number.isNaN(km) || Number.isNaN(metres)) return null
  return km + metres / 1000
}
