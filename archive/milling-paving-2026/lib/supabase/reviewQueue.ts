import { supabase } from './client'

export const LIFECYCLE_EVENT_TYPES = [
  'mill',
  'tack_coat',
  'level_course',
  'top_lift',
  'shoulder_strip',
  'shouldering',
  'milled_tie_in',
] as const

export interface PendingReviewEvent {
  id: string
  eventType: string
  eventDate: string
  quantity: number | null
  fromStation: number
  toStation: number
  locationDescription: string | null
  fieldNarrative: string | null
  createdAt: string
  roadSegmentId: string
  direction: string
  highway: string
  contractNumber: string
  projectName: string
}

// Deeply nested PostgREST embed (surface_lifecycle_events -> road_segments ->
// road_segment_groups -> jobs -> projects) so the review queue can show which
// contract/segment each pending entry belongs to in one request. Supabase's
// generated types aren't wired up in this project, so the raw row is typed
// loosely and mapped explicitly below rather than trusting inference through
// four levels of embedding.
export async function fetchPendingReviewEvents(): Promise<PendingReviewEvent[]> {
  const { data, error } = await supabase
    .from('surface_lifecycle_events')
    .select(
      `id, event_type, event_date, quantity, from_station, to_station,
       location_description, field_narrative, created_at, road_segment_id,
       road_segments!inner (
         direction, highway,
         road_segment_groups!inner (
           jobs!inner (
             projects!inner ( contract_number, name )
           )
         )
       )`,
    )
    .eq('review_status', 'pending_review')
    .order('created_at', { ascending: true })
  if (error) throw error

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((row: any) => ({
    id: row.id,
    eventType: row.event_type,
    eventDate: row.event_date,
    quantity: row.quantity === null ? null : Number(row.quantity),
    fromStation: Number(row.from_station),
    toStation: Number(row.to_station),
    locationDescription: row.location_description,
    fieldNarrative: row.field_narrative,
    createdAt: row.created_at,
    roadSegmentId: row.road_segment_id,
    direction: row.road_segments.direction,
    highway: row.road_segments.highway,
    contractNumber: row.road_segments.road_segment_groups.jobs.projects.contract_number,
    projectName: row.road_segments.road_segment_groups.jobs.projects.name,
  }))
}

export async function confirmReviewEvent(params: {
  id: string
  eventType: string
  quantity: number | null
  fromStation: number
  toStation: number
}): Promise<void> {
  // reviewed_by/reviewed_at are NOT sent — the server derives them from the
  // acting identity when review_status transitions to 'confirmed'. This
  // update also only succeeds server-side if the acting identity is a
  // coordinator; a field_staff calling this gets a clear Postgres error.
  const { error } = await supabase
    .from('surface_lifecycle_events')
    .update({
      event_type: params.eventType,
      quantity: params.quantity,
      from_station: params.fromStation,
      to_station: params.toStation,
      review_status: 'confirmed',
    })
    .eq('id', params.id)
  if (error) throw error
}
