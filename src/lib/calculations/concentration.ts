export interface ConcentrationInput {
  itemNo: string
  value: number
}

export interface ConcentrationRow extends ConcentrationInput {
  cumulativeShare: number
}

/**
 * Sorted descending by contract value, with a running cumulative share of
 * the total — computable from tendered quantities and rates alone, no
 * production data needed (unlike margin-to-date, which needs placed
 * quantity). See novacore_margin_exposure.jsx's "concentration" view: on a
 * typical contract a handful of items carry most of the value, so
 * estimating precision on the rest can't move the outcome the way a small
 * error in those few can.
 */
export function concentrationByValue(items: readonly ConcentrationInput[]): ConcentrationRow[] {
  const total = items.reduce((sum, item) => sum + item.value, 0)
  const sorted = [...items].sort((a, b) => b.value - a.value)
  let running = 0
  return sorted.map((item) => {
    running += item.value
    return { ...item, cumulativeShare: total > 0 ? running / total : 0 }
  })
}
