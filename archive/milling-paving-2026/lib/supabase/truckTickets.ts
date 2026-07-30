import { supabase } from './client'

export interface TruckTicketRow {
  id: string
  direction: string
  arrivalSequence: number
  vehicleNumber: string
  ticketNumber: string
  netTonnage: number
  liftType: 'top_lift' | 'level_course'
  isCorrection: boolean
  supersededBy: string | null
  isVoided: boolean
  correctionReason: string | null
  loggedTimestamp: string
}

const TRUCK_TICKET_SELECT =
  'id, direction, arrival_sequence, vehicle_number, ticket_number, net_tonnage, lift_type, is_correction, superseded_by, is_voided, correction_reason, logged_timestamp'

function mapTruckTicketRow(row: {
  id: string
  direction: string
  arrival_sequence: number
  vehicle_number: string
  ticket_number: string
  net_tonnage: number
  lift_type: string
  is_correction: boolean
  superseded_by: string | null
  is_voided: boolean
  correction_reason: string | null
  logged_timestamp: string
}): TruckTicketRow {
  return {
    id: row.id,
    direction: row.direction,
    arrivalSequence: Number(row.arrival_sequence),
    vehicleNumber: row.vehicle_number,
    ticketNumber: row.ticket_number,
    netTonnage: Number(row.net_tonnage),
    liftType: row.lift_type as 'top_lift' | 'level_course',
    isCorrection: row.is_correction,
    supersededBy: row.superseded_by,
    isVoided: row.is_voided,
    correctionReason: row.correction_reason,
    loggedTimestamp: row.logged_timestamp,
  }
}

export async function fetchTodaysTruckTickets(roadSegmentId: string, date: string): Promise<TruckTicketRow[]> {
  const { data, error } = await supabase
    .from('truck_tickets')
    .select(TRUCK_TICKET_SELECT)
    .eq('road_segment_id', roadSegmentId)
    .eq('paving_date', date)
    .order('arrival_sequence', { ascending: true })
  if (error) throw error
  return (data ?? []).map(mapTruckTicketRow)
}

export async function insertTruckTicket(params: {
  roadSegmentId: string
  direction: string
  date: string
  vehicleNumber: string
  ticketNumber: string
  netTonnage: number
  liftType: 'top_lift' | 'level_course'
}): Promise<TruckTicketRow> {
  // entered_by is deliberately omitted — server-derived via the same
  // effective_crew_member_id() trigger width_readings uses. arrival_sequence
  // is omitted too — assigned atomically server-side (see migration
  // 20260719120000), never client-computed.
  const { data, error } = await supabase
    .from('truck_tickets')
    .insert({
      road_segment_id: params.roadSegmentId,
      direction: params.direction,
      paving_date: params.date,
      vehicle_number: params.vehicleNumber,
      ticket_number: params.ticketNumber,
      net_tonnage: params.netTonnage,
      lift_type: params.liftType,
    })
    .select(TRUCK_TICKET_SELECT)
    .single()
  if (error) throw error
  return mapTruckTicketRow(data)
}

/**
 * Corrects an existing truck_ticket via the same append-only
 * supersede-workflow shape as supersedeWidthReading — insert a brand-new
 * row reusing the original's arrival_sequence (is_correction=true exempts
 * it from the uniqueness check and the atomic-assignment trigger, see the
 * migration), then point the original at it. The original is never edited
 * in place.
 */
export async function supersedeTruckTicket(params: {
  originalId: string
  roadSegmentId: string
  direction: string
  date: string
  arrivalSequence: number
  correctedVehicleNumber: string
  correctedTicketNumber: string
  correctedNetTonnage: number
  correctedLiftType: 'top_lift' | 'level_course'
  reason: string
}): Promise<TruckTicketRow> {
  const { data: inserted, error: insertError } = await supabase
    .from('truck_tickets')
    .insert({
      road_segment_id: params.roadSegmentId,
      direction: params.direction,
      paving_date: params.date,
      arrival_sequence: params.arrivalSequence,
      vehicle_number: params.correctedVehicleNumber,
      ticket_number: params.correctedTicketNumber,
      net_tonnage: params.correctedNetTonnage,
      lift_type: params.correctedLiftType,
      is_correction: true,
      correction_reason: params.reason,
    })
    .select(TRUCK_TICKET_SELECT)
    .single()
  if (insertError) throw insertError

  const { error: updateError } = await supabase
    .from('truck_tickets')
    .update({ superseded_by: inserted.id, correction_reason: params.reason })
    .eq('id', params.originalId)
  if (updateError) throw updateError

  return mapTruckTicketRow(inserted)
}

/** Voids a ticket in place — no new row, unlike a correction. Role-gated server-side identically to superseded_by. */
export async function voidTruckTicket(ticketId: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from('truck_tickets')
    .update({ is_voided: true, correction_reason: reason })
    .eq('id', ticketId)
  if (error) throw error
}

/** Mirror of insertWidthReadingBetween, via insert_truck_ticket_between (see migration 20260719120000). */
export async function insertTruckTicketBetween(
  afterTicketId: string,
  vehicleNumber: string,
  ticketNumber: string,
  netTonnage: number,
  liftType: 'top_lift' | 'level_course',
): Promise<TruckTicketRow> {
  const { data, error } = await supabase.rpc('insert_truck_ticket_between', {
    after_ticket_id: afterTicketId,
    new_vehicle_number: vehicleNumber,
    new_ticket_number: ticketNumber,
    new_net_tonnage: netTonnage,
    new_lift_type: liftType,
  })
  if (error) throw error
  return mapTruckTicketRow(data)
}

/** Mirror of insertWidthReadingBefore, via insert_truck_ticket_before (see migration 20260719120000). */
export async function insertTruckTicketBefore(
  beforeTicketId: string,
  vehicleNumber: string,
  ticketNumber: string,
  netTonnage: number,
  liftType: 'top_lift' | 'level_course',
): Promise<TruckTicketRow> {
  const { data, error } = await supabase.rpc('insert_truck_ticket_before', {
    before_ticket_id: beforeTicketId,
    new_vehicle_number: vehicleNumber,
    new_ticket_number: ticketNumber,
    new_net_tonnage: netTonnage,
    new_lift_type: liftType,
  })
  if (error) throw error
  return mapTruckTicketRow(data)
}

export interface PastTruckTicketRow extends TruckTicketRow {
  roadSegmentId: string
  date: string
  highway: string
  projectContractNumber: string
  projectName: string
}

export interface TruckTicketDaySegmentGroup {
  roadSegmentId: string
  direction: string
  highway: string
  projectContractNumber: string
  projectName: string
  totalTonnage: number
  tickets: PastTruckTicketRow[]
}

const PAST_TRUCK_TICKET_SELECT = `
  id, road_segment_id, direction, paving_date, arrival_sequence, vehicle_number, ticket_number, net_tonnage,
  lift_type, is_correction, superseded_by, is_voided, correction_reason, logged_timestamp,
  road_segments!inner ( road_segment_groups!inner ( highway, jobs!inner ( projects!inner ( id, contract_number, name ) ) ) )
`

interface RawPastTruckTicketRow {
  id: string
  road_segment_id: string
  direction: string
  paving_date: string
  arrival_sequence: number
  vehicle_number: string
  ticket_number: string
  net_tonnage: number
  lift_type: string
  is_correction: boolean
  superseded_by: string | null
  is_voided: boolean
  correction_reason: string | null
  logged_timestamp: string
  road_segments: {
    road_segment_groups: {
      highway: string
      jobs: {
        projects: {
          id: string
          contract_number: string
          name: string
        }
      }
    }
  }
}

function mapPastTruckTicketRow(row: RawPastTruckTicketRow): PastTruckTicketRow {
  const group = row.road_segments.road_segment_groups
  const project = group.jobs.projects
  return {
    id: row.id,
    roadSegmentId: row.road_segment_id,
    direction: row.direction,
    date: row.paving_date,
    arrivalSequence: Number(row.arrival_sequence),
    vehicleNumber: row.vehicle_number,
    ticketNumber: row.ticket_number,
    netTonnage: Number(row.net_tonnage),
    liftType: row.lift_type as 'top_lift' | 'level_course',
    isCorrection: row.is_correction,
    supersededBy: row.superseded_by,
    isVoided: row.is_voided,
    correctionReason: row.correction_reason,
    loggedTimestamp: row.logged_timestamp,
    highway: group.highway,
    projectContractNumber: project.contract_number,
    projectName: project.name,
  }
}

/**
 * Every truck ticket logged on one specific date, across every segment
 * touched that day — grouped by segment, mirroring fetchDayReadingGroups's
 * shape exactly so MillingDayDetailScreen (day-level, activity-parameterized)
 * can render both lists the same way. Truck tickets have no "session"
 * concept the way width_readings does (see the Stage 2 investigation —
 * arrival_sequence is arrival order, not a direction-of-travel walk), so
 * this is the only past-tickets view: day + segment, not day + segment +
 * direction-thread.
 */
export async function fetchDayTruckTickets(date: string): Promise<TruckTicketDaySegmentGroup[]> {
  const { data, error } = await supabase.from('truck_tickets').select(PAST_TRUCK_TICKET_SELECT).eq('paving_date', date)
  if (error) throw error

  const rows = (data ?? []).map((row) => mapPastTruckTicketRow(row as unknown as RawPastTruckTicketRow))

  const bySegment = new Map<string, PastTruckTicketRow[]>()
  for (const row of rows) {
    const existing = bySegment.get(row.roadSegmentId)
    if (existing) existing.push(row)
    else bySegment.set(row.roadSegmentId, [row])
  }

  const groups: TruckTicketDaySegmentGroup[] = []
  for (const [roadSegmentId, segmentRows] of bySegment) {
    const sorted = [...segmentRows].sort((a, b) =>
      a.arrivalSequence !== b.arrivalSequence
        ? a.arrivalSequence - b.arrivalSequence
        : a.loggedTimestamp.localeCompare(b.loggedTimestamp),
    )
    // Voided and superseded tickets stay visible (struck through) but
    // never contribute to tonnage, same as width_readings' area exclusion.
    const activeTonnage = sorted
      .filter((t) => t.supersededBy === null && !t.isVoided && t.liftType === 'top_lift')
      .reduce((sum, t) => sum + t.netTonnage, 0)
    const first = sorted[0]
    groups.push({
      roadSegmentId,
      direction: first.direction,
      highway: first.highway,
      projectContractNumber: first.projectContractNumber,
      projectName: first.projectName,
      totalTonnage: activeTonnage,
      tickets: sorted,
    })
  }

  return groups.sort((a, b) => a.projectContractNumber.localeCompare(b.projectContractNumber) || a.direction.localeCompare(b.direction))
}

/**
 * Per-date top-lift tonnage totals for a project, before excludeDate — the
 * raw material MillingHomeScreen merges into its day headings alongside
 * width_readings' own area total (see the Stage 2 investigation: tonnage
 * aggregates at the day level, not per direction-of-travel session, since
 * tickets have no thread concept — so this is keyed by date only, not
 * date+segment the way width_readings' own session grouping is).
 */
export async function fetchTonnageByDay(projectId: string, excludeDate: string): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from('truck_tickets')
    .select('paving_date, net_tonnage, lift_type, road_segments!inner ( road_segment_groups!inner ( jobs!inner ( project_id ) ) )')
    .eq('road_segments.road_segment_groups.jobs.project_id', projectId)
    .eq('lift_type', 'top_lift')
    .is('superseded_by', null)
    .eq('is_voided', false)
    .neq('paving_date', excludeDate)
  if (error) throw error

  const totals = new Map<string, number>()
  for (const row of (data ?? []) as unknown as { paving_date: string; net_tonnage: number }[]) {
    totals.set(row.paving_date, (totals.get(row.paving_date) ?? 0) + Number(row.net_tonnage))
  }
  return totals
}
