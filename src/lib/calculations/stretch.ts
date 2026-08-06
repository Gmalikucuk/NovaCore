/**
 * The physical stretch a quantity_record covers — reach (from station_from/
 * station_to) and the area a width implies over it. Shared by both entry
 * screens so this arithmetic exists in exactly one place, not duplicated a
 * third time alongside the pre-existing per-screen `reachMetres` display
 * variables (which are — despite the name — station values in km, used only
 * to feed `station()`'s own km-expecting formatter; unrelated to this file
 * and left as-is, since fixing that naming is outside this brief's scope).
 */

/** station_from/station_to are stored in km; a physical reach for area math needs metres. */
export function reachMetres(stationFrom: number | null, stationTo: number | null): number | null {
  if (stationFrom === null || stationTo === null) return null
  return (stationTo - stationFrom) * 1000
}

/** average width (m) × reach (m) = area (m²) — the convenience-fill value, never itself the record of truth once a person has entered a different figure directly. */
export function computeAreaFromWidth(averageWidth: number | null, stationFrom: number | null, stationTo: number | null): number | null {
  const reach = reachMetres(stationFrom, stationTo)
  if (averageWidth === null || reach === null) return null
  return averageWidth * reach
}

/**
 * entered - computed, only when both are known — never a bare 0 standing in
 * for "nothing to compare." A tiny floating-point epsilon (0.005 m²) keeps
 * an agreeing pair (e.g. 5.5 × 2790 = 15345 exactly) from reading as a
 * meaningless fractional disagreement; anything past that is real and must
 * be shown, per the standing rule that the field sheet supersedes the
 * calculation without either number being silently overwritten.
 */
export function areaDifference(entered: number | null, computed: number | null): number | null {
  if (entered === null || computed === null) return null
  const diff = entered - computed
  return Math.abs(diff) < 0.005 ? 0 : diff
}
