// ─────────────────────────────────────────────────────────────────────────
// Rates' column control (Rates redesign) — Item, Unit price, Extended
// amount are always shown, never in this set (entry needs Unit price;
// reading needs Extended amount; neither screen state has a reason to hide
// either). Everything else here is optional, persisted per seat via
// user_view_preferences, resolved fresh on every load against the CURRENT
// contract and seat rather than trusted from what was saved.
// ─────────────────────────────────────────────────────────────────────────

export interface RatesColumnVisibility {
  unitCost: boolean
  extCost: boolean
  margin: boolean
  marginPercent: boolean
  percentComplete: boolean
  authorizedValue: boolean
}

/**
 * Resolves what a seat actually sees, three inputs at a time:
 *
 * - `raw` — this seat's saved column choices, one key at a time (a key
 *   absent from the blob means "never touched," not "off"; matches
 *   sanitizeOverviewPreferences' own per-field fallback, not a whole-blob
 *   present/absent flag, so a person who has only ever unchecked ONE
 *   column keeps every other default working).
 * - `costVisible` — this seat's own right to see cost/margin at all
 *   (costTrackingVisible: cost tracking on, OR this seat holds set_cost —
 *   the same exemption the database itself already makes). Cost-family
 *   columns are forced false whenever this is false, regardless of what a
 *   stale saved preference says — a right revoked after a preference was
 *   saved must win immediately, not just be hidden by a checkbox this seat
 *   can no longer reach. This is what makes rights non-negotiable by the
 *   control rather than merely a matter of which checkboxes render.
 * - `costTrackingEnabled` — the CONTRACT's own setting, not this seat's
 *   right, deciding whether a seat who has never touched the control sees
 *   cost/margin by default. On a contract where cost is off (both real
 *   contracts today), a set_cost holder still starts on the plain 3-column
 *   view — they can turn cost columns on themselves, but nothing forces
 *   four mostly-empty columns on them just because they happen to hold the
 *   right to enter figures nobody has entered yet.
 *
 * percentComplete/authorizedValue apply to Lump Sum/Provisional Sum Items
 * only, and are optional regardless of cost tracking — unrelated to cost,
 * so costVisible/costTrackingEnabled play no part in their default (always
 * off until a seat asks for them, same as today).
 */
export function resolveRatesColumns(raw: Record<string, unknown> | null, costVisible: boolean, costTrackingEnabled: boolean): RatesColumnVisibility {
  const source = raw ?? {}
  const bool = (key: string, fallback: boolean): boolean => (typeof source[key] === 'boolean' ? (source[key] as boolean) : fallback)
  const costDefault = costVisible && costTrackingEnabled
  return {
    unitCost: costVisible && bool('unitCost', costDefault),
    extCost: costVisible && bool('extCost', costDefault),
    margin: costVisible && bool('margin', costDefault),
    marginPercent: costVisible && bool('marginPercent', costDefault),
    percentComplete: bool('percentComplete', false),
    authorizedValue: bool('authorizedValue', false),
  }
}
