export const UNITS = ['Tonne', 'm²', 'm³', 'm', 'Each', 'Litre', 'Lump Sum', 'Prov. Sum'] as const

export type Unit = (typeof UNITS)[number]
