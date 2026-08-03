/**
 * Numeric-aware comparator for item codes: "05.03.04" sorts after "05.03.03",
 * and "04.10" sorts after "04.09" — a plain string compare gets the second
 * case wrong ("04.10" < "04.09" lexicographically, since '1' < '9'). Splits
 * each code into alternating digit/non-digit runs and compares digit runs
 * as numbers.
 */
/**
 * Section headings from Schedule 7 of every MoTT contract — the same names
 * the BC contractor workbook uses verbatim. Not stored anywhere in the
 * schema (no `section` column exists), so this is the one place they're
 * recorded; a prefix genuinely not on this list falls back to a generated
 * "Section NN" rather than guessing at a name.
 */
const SECTION_NAMES: Record<string, string> = {
  '01': '01 General',
  '02': '02 Traffic Management',
  '03': '03 Supply Aggregate in Stockpile',
  '04': '04 Construction',
  '05': '05 Paving',
  '06': '06 Signing',
}

/** The leading two-digit prefix of an item_number ("05.03.03" -> "05"). */
export function sectionPrefix(itemNumber: string): string {
  return itemNumber.match(/^\d+/)?.[0].padStart(2, '0').slice(0, 2) ?? itemNumber
}

export function sectionLabel(prefix: string): string {
  return SECTION_NAMES[prefix] ?? `Section ${prefix}`
}

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
