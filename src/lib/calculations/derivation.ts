import type { AreaBasis } from '../supabase/items'
import type { DerivationBasis } from '../supabase/derivationRules'
import { reachMetres } from './stretch'
import { sumOrNull } from './margin'

// ─────────────────────────────────────────────────────────────────────────
// A quantity nobody measures directly on its own record — tack coat, hot
// joint sealant, penetrating primer — computed instead from coefficient x
// a figure summed across OTHER Items' same-date records (item_derivation_
// rules/item_derivation_sources, 0039). Two things this file deliberately
// does NOT do:
//
//   - decide which records are "the same date" or resolve draft/confirmed/
//     superseded status. The caller hands this file only the records that
//     should count; this file just sums and multiplies.
//   - exclude specific records within a source Item (e.g. hot joint
//     sealant's mainline run excluding pullouts). See 0039's own header:
//     that is the ordinary "computed figure disagrees with entered
//     figure, person corrects it, never auto-corrected" case, not a rule
//     the schema encodes.
// ─────────────────────────────────────────────────────────────────────────

export interface DerivationRule {
  itemId: string
  coefficient: number
  basis: DerivationBasis
}

export interface SourceRecord {
  itemId: string
  quantity: number
  area: number | null
  stationFrom: number | null
  stationTo: number | null
}

/**
 * What ONE source record contributes. 'length' reads reach (station_to -
 * station_from) regardless of the source Item's own area_basis — a linear
 * figure is a linear figure. 'area' reads wherever that Item's own area
 * actually lives: quantity itself for a quantity_is_area source (an
 * Item's quantity IS its area, 0038), the area field for a
 * separately_measured one. Null — never 0 — when the figure this rule
 * needs isn't on the record yet (no stations entered, no area entered),
 * so an incomplete source silently drops out of the sum rather than
 * counting as zero progress.
 */
export function recordContribution(
  basis: DerivationBasis,
  sourceAreaBasis: AreaBasis | null,
  record: Pick<SourceRecord, 'quantity' | 'area' | 'stationFrom' | 'stationTo'>,
): number | null {
  if (basis === 'length') return reachMetres(record.stationFrom, record.stationTo)
  if (sourceAreaBasis === 'quantity_is_area') return record.quantity
  if (sourceAreaBasis === 'separately_measured') return record.area
  return null
}

/**
 * coefficient x the summed contribution of every source record handed in.
 * Null — never a bare 0 — when nothing has been recorded for any source
 * Item yet, so the proposal simply doesn't appear, the same as an absent
 * width leaves the area convenience-fill blank today (stretch.ts).
 */
export function deriveQuantity(
  rule: Pick<DerivationRule, 'coefficient' | 'basis'>,
  sourceAreaBasisByItemId: ReadonlyMap<string, AreaBasis | null>,
  sourceRecords: readonly SourceRecord[],
): number | null {
  const contributions = sourceRecords.map((r) => recordContribution(rule.basis, sourceAreaBasisByItemId.get(r.itemId) ?? null, r))
  const total = sumOrNull(contributions)
  return total === null ? null : rule.coefficient * total
}
