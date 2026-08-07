import { supabase } from './client'
import { filterEffective } from '../calculations/effectiveEntries'

export interface EffectiveQuantityRow {
  itemId: string
  quantity: number
}

/**
 * Reads quantity_records_effective directly (0001, renamed by 0009) — the
 * supersession rule (confirmed, no confirmed successor) lives entirely in
 * that view's SQL. This never re-derives which rows are effective; it only
 * fetches what the view already decided, for itemProgress.ts's
 * placedToDateByItem() to aggregate. security_invoker=on means this is still
 * scoped by quantity_records_select_member underneath — every seat sees
 * this, quantities carry no price information on their own.
 */
export async function fetchEffectiveQuantities(contractId: string): Promise<EffectiveQuantityRow[]> {
  const { data, error } = await supabase
    .from('quantity_records_effective')
    .select('item_id, quantity')
    .eq('contract_id', contractId)
  if (error) throw error
  return (data ?? []).map((row) => ({
    itemId: row.item_id as string,
    quantity: Number(row.quantity),
  }))
}

/**
 * Every station value on a confirmed, non-superseded record, for the
 * station ribbon (Progress). Deliberately NOT read from quantity_records_
 * effective: that view was defined as `select r.*` when station_from/
 * station_to were the newest columns on the table, and was never
 * recreated when direction/lki_segment/lki_version/average_width/area
 * were added later (0034) — a Postgres view's column list is frozen at
 * creation/replace time, `select *` does not pick up columns added to the
 * underlying table afterward. Recreating the view would be a schema
 * change this brief is scoped not to make ("reads only... if you believe
 * one is needed, stop and explain" — reported, not silently patched).
 * Reading quantity_records directly and re-deriving "effective" with the
 * already-tested client-side twin of the view's own rule
 * (effectiveEntries.ts's filterEffective, built for exactly this kind of
 * case) avoids the schema change entirely while producing the identical
 * set the view would if it were caught up. RLS (quantity_records_
 * select_member) scopes this exactly as it would the view — no security
 * surface change, only which columns are visible past that gate.
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
