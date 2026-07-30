import { supabase } from './client'

export interface ExtraAreaEventRow {
  id: string
  eventType: string
  eventDate: string
  quantity: number
  fromStation: number
  toStation: number
  locationDescription: string
  fieldNarrative: string | null
  reviewStatus: 'pending_review' | 'confirmed'
  createdAt: string
}

const EXTRA_AREA_SELECT =
  'id, event_type, event_date, quantity, from_station, to_station, location_description, field_narrative, review_status, created_at'

function mapExtraAreaRow(row: {
  id: string
  event_type: string
  event_date: string
  quantity: number
  from_station: number
  to_station: number
  location_description: string | null
  field_narrative: string | null
  review_status: string
  created_at: string
}): ExtraAreaEventRow {
  return {
    id: row.id,
    eventType: row.event_type,
    eventDate: row.event_date,
    quantity: Number(row.quantity),
    fromStation: Number(row.from_station),
    toStation: Number(row.to_station),
    locationDescription: row.location_description ?? '',
    fieldNarrative: row.field_narrative,
    reviewStatus: row.review_status as 'pending_review' | 'confirmed',
    createdAt: row.created_at,
  }
}

/** Today's manually-entered extra-area events for a segment — excludes the normal computed_from_readings entries, which this list has nothing to do with. */
export async function fetchTodaysExtraAreaEvents(
  roadSegmentId: string,
  date: string,
): Promise<ExtraAreaEventRow[]> {
  const { data, error } = await supabase
    .from('surface_lifecycle_events')
    .select(EXTRA_AREA_SELECT)
    .eq('road_segment_id', roadSegmentId)
    .eq('event_date', date)
    .eq('entry_method', 'manual_area_entry')
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []).map(mapExtraAreaRow)
}

export async function insertExtraAreaEvent(params: {
  roadSegmentId: string
  date: string
  eventType: string
  quantity: number
  locationDescription: string
  fromStation: number
  toStation: number
  fieldNarrative: string | null
}): Promise<ExtraAreaEventRow> {
  // entered_by is omitted — server-derived from effective_crew_member_id()
  // via the same BEFORE INSERT trigger every other attribution column in
  // this schema uses. review_status is omitted too, deliberately: the
  // surface_lifecycle_events_set_review_status trigger derives it from
  // entry_method unconditionally, ignoring whatever the client sends — so
  // there's nothing correct to send here anyway.
  const { data, error } = await supabase
    .from('surface_lifecycle_events')
    .insert({
      road_segment_id: params.roadSegmentId,
      event_type: params.eventType,
      event_date: params.date,
      quantity: params.quantity,
      from_station: params.fromStation,
      to_station: params.toStation,
      entry_method: 'manual_area_entry',
      location_description: params.locationDescription,
      field_narrative: params.fieldNarrative,
    })
    .select(EXTRA_AREA_SELECT)
    .single()
  if (error) throw error
  return mapExtraAreaRow(data)
}
