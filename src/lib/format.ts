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

/** A chainage/station value in km — always a fixed decimal count (3 by default, matching a station's usual precision), never a thousands separator. `digits` narrows it for a compressed display (ChainageStrip's axis ticks use 0 or 1 depending on how much of the contract is on screen at once). */
export function station(n: number | null | undefined, digits = 3): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return n.toFixed(digits)
}
