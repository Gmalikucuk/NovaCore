/**
 * Numeric-aware comparator for item codes: "05.03.04" sorts after "05.03.03",
 * and "04.10" sorts after "04.09" — a plain string compare gets the second
 * case wrong ("04.10" < "04.09" lexicographically, since '1' < '9'). Splits
 * each code into alternating digit/non-digit runs and compares digit runs
 * as numbers.
 */
export function compareItemCodes(a: string, b: string): number {
  const chunk = (s: string) => s.match(/\d+|\D+/g) ?? []
  const ac = chunk(a)
  const bc = chunk(b)
  const len = Math.max(ac.length, bc.length)

  for (let i = 0; i < len; i++) {
    const x = ac[i] ?? ''
    const y = bc[i] ?? ''
    const bothNumeric = /^\d+$/.test(x) && /^\d+$/.test(y)
    if (bothNumeric) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}
