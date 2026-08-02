export const UNITS = ['Tonne', 'm²', 'm³', 'm', 'Each', 'Litre', 'Lump Sum', 'Prov. Sum'] as const

export type Unit = (typeof UNITS)[number]

const LUMP_UNITS: readonly string[] = ['Lump Sum', 'Prov. Sum']

/** Lump Sum / Prov. Sum items don't have a meaningful percent-complete against their bid_quantity (typically 1) — see lineItemProgress.ts. */
export function isLumpUnit(unit: string): boolean {
  return LUMP_UNITS.includes(unit)
}
