import { supabase } from './client'
import { filterEffective } from '../calculations/effectiveEntries'

/**
 * Every station value on a confirmed, non-superseded record, for the
 * station ribbon (Progress). Reads quantity_records directly rather than
 * quantity_records_effective and re-derives "effective" with the
 * client-side twin of the view's own rule (effectiveEntries.ts's
 * filterEffective — see that file for the precondition this relies on).
 *
 * This was originally a workaround: quantity_records_effective was frozen
 * at an old column list and did not expose lki_segment. That has since
 * been fixed (the view is recreated with an explicit, current column list
 * — see the migration that did it for the guard against this recurring).
 * Left reading the table directly anyway rather than switching to the
 * now-fixed view — it already works, is tested, and this file is the only
 * caller, so there is nothing to gain by moving it back.
 */
export interface EffectiveStationRow {
  itemId: string
  stationFrom: number | null
  stationTo: number | null
  lkiSegment: number | null
}

interface RawStationRow {
  id: string
  item_id: string
  station_from: string | null
  station_to: string | null
  lki_segment: number | null
  status: 'draft' | 'confirmed'
  supersedes: string | null
}

export async function fetchEffectiveStationRecords(contractId: string): Promise<EffectiveStationRow[]> {
  const { data, error } = await supabase
    .from('quantity_records')
    .select('id, item_id, station_from, station_to, lki_segment, status, supersedes')
    .eq('contract_id', contractId)
    .eq('status', 'confirmed')
  if (error) throw error
  const rows = (data ?? []) as RawStationRow[]
  return filterEffective(rows).map((row) => ({
    itemId: row.item_id,
    stationFrom: row.station_from === null ? null : Number(row.station_from),
    stationTo: row.station_to === null ? null : Number(row.station_to),
    lkiSegment: row.lki_segment,
  }))
}
