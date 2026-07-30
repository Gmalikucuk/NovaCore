import { calculateSegments, cumulativeArea, type WidthReading } from '../calculations/segmentArea'
import { supabase } from './client'

export interface DashboardProject {
  id: string
  contractNumber: string
  name: string
}

export interface ContractItemTarget {
  id: string
  itemCode: string
  description: string
  section: string
  uom: string
  contractQty: number | null
  unitPrice: number | null
  eventType: string | null
  isLumpSum: boolean
}

export interface ItemProgress {
  target: ContractItemTarget
  /** null when this item has no event_type mapping and isn't lump sum — genuinely "not yet tracked", not zero. */
  quantityToDate: number | null
  quantityThisMonth: number | null
  /** null unless there's both an event_type mapping and a contract_qty to divide by. */
  percentComplete: number | null
}

export interface DashboardStats {
  daysLogged: number
  totalAreaMilledM2: number
  totalTonnesPaved: number
}

export interface DashboardData {
  project: DashboardProject
  stats: DashboardStats
  itemsBySection: Map<string, ItemProgress[]>
}

export async function fetchContractItemTargets(projectId: string): Promise<ContractItemTarget[]> {
  const { data, error } = await supabase
    .from('contract_item_targets')
    .select('id, item_code, description, section, uom, contract_qty, unit_price, event_type, is_lump_sum')
    .eq('project_id', projectId)
    .order('item_code')
  if (error) throw error
  return (data ?? []).map((row) => ({
    id: row.id,
    itemCode: row.item_code,
    description: row.description,
    section: row.section,
    uom: row.uom,
    contractQty: row.contract_qty === null ? null : Number(row.contract_qty),
    unitPrice: row.unit_price === null ? null : Number(row.unit_price),
    eventType: row.event_type,
    isLumpSum: row.is_lump_sum,
  }))
}

async function fetchProjectSegmentIds(projectId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('road_segments')
    .select('id, road_segment_groups!inner(jobs!inner(project_id))')
    .eq('road_segment_groups.jobs.project_id', projectId)
  if (error) throw error
  return (data ?? []).map((row) => row.id as string)
}

interface RawWidthReading {
  road_segment_id: string
  paving_date: string
  direction: string
  station_sequence: number
  station: number
  width: number
  superseded_by: string | null
}

/**
 * Total area milled to date is deliberately NOT a raw SQL sum over
 * width_readings — a reading only means something as a consecutive
 * station/width pair walked in field order. Groups every non-superseded
 * reading for the project's segments by (road_segment_id, date, direction),
 * exactly like the live running total on MillingEntryScreen, and reuses the
 * same tested calculateSegments/cumulativeArea rather than approximating.
 */
async function fetchTotalAreaMilled(segmentIds: string[]): Promise<number> {
  if (segmentIds.length === 0) return 0
  const { data, error } = await supabase
    .from('width_readings')
    .select('road_segment_id, paving_date, direction, station_sequence, station, width, superseded_by')
    .eq('activity', 'milling')
    .in('road_segment_id', segmentIds)
  if (error) throw error

  const active = ((data ?? []) as RawWidthReading[]).filter((r) => r.superseded_by === null)

  const groups = new Map<string, RawWidthReading[]>()
  for (const row of active) {
    const key = `${row.road_segment_id}|${row.paving_date}|${row.direction}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  let total = 0
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.station_sequence - b.station_sequence)
    if (sorted.length < 2) continue
    const readings: WidthReading[] = sorted.map((r) => ({
      stationSequence: r.station_sequence,
      station: Number(r.station),
      width: Number(r.width),
    }))
    total += cumulativeArea(calculateSegments(readings))
  }
  return total
}

/** Simple sum, per spec — top_lift tonnage is a real per-truck measurement, not a derived quantity. Excludes voided and superseded (corrected-away) tickets. */
async function fetchTotalTonnesPaved(segmentIds: string[]): Promise<number> {
  if (segmentIds.length === 0) return 0
  const { data, error } = await supabase
    .from('truck_tickets')
    .select('net_tonnage')
    .in('road_segment_id', segmentIds)
    .eq('lift_type', 'top_lift')
    .eq('is_voided', false)
    .is('superseded_by', null)
  if (error) throw error
  return (data ?? []).reduce((sum, row) => sum + Number(row.net_tonnage), 0)
}

interface RawEventRow {
  event_type: string
  quantity: number | null
  event_date: string
}

async function fetchConfirmedEventRows(segmentIds: string[]): Promise<RawEventRow[]> {
  if (segmentIds.length === 0) return []
  const { data, error } = await supabase
    .from('surface_lifecycle_events')
    .select('event_type, quantity, event_date')
    .in('road_segment_id', segmentIds)
    .eq('review_status', 'confirmed')
  if (error) throw error
  return (data ?? []) as RawEventRow[]
}

function sumByEventType(rows: RawEventRow[], monthStart?: string): Map<string, number> {
  const totals = new Map<string, number>()
  for (const row of rows) {
    if (row.quantity === null) continue
    if (monthStart && row.event_date < monthStart) continue
    totals.set(row.event_type, (totals.get(row.event_type) ?? 0) + Number(row.quantity))
  }
  return totals
}

/** "Days with any field data logged" counts activity, not confirmation — any width reading, truck ticket, or lifecycle event on a date counts, regardless of review_status. width_readings is deliberately NOT scoped to activity='milling' here (unlike fetchTotalAreaMilled) — this stat wants a day with EITHER milling or paving readings to count, not just milling's. */
async function fetchFieldDataDayCount(segmentIds: string[]): Promise<number> {
  if (segmentIds.length === 0) return 0
  const [widthRes, truckRes, eventRes] = await Promise.all([
    supabase.from('width_readings').select('paving_date').in('road_segment_id', segmentIds),
    supabase.from('truck_tickets').select('paving_date').in('road_segment_id', segmentIds),
    supabase.from('surface_lifecycle_events').select('event_date').in('road_segment_id', segmentIds),
  ])
  if (widthRes.error) throw widthRes.error
  if (truckRes.error) throw truckRes.error
  if (eventRes.error) throw eventRes.error

  const dates = new Set<string>()
  for (const row of widthRes.data ?? []) dates.add(row.paving_date)
  for (const row of truckRes.data ?? []) dates.add(row.paving_date)
  for (const row of eventRes.data ?? []) dates.add(row.event_date)
  return dates.size
}

function currentMonthStart(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
}

/**
 * project is the caller's responsibility to supply (from useCurrentProject
 * — see currentProject.ts) rather than this module guessing one. It used
 * to pick "whichever project has contract_item_targets rows, .limit(1)",
 * silently correct only by accident while there was exactly one project
 * with targets seeded; a second one would have made it nondeterministic.
 */
export async function fetchDashboardData(project: DashboardProject): Promise<DashboardData> {
  const segmentIds = await fetchProjectSegmentIds(project.id)

  const [targets, totalArea, totalTonnes, confirmedRows, daysLogged] = await Promise.all([
    fetchContractItemTargets(project.id),
    fetchTotalAreaMilled(segmentIds),
    fetchTotalTonnesPaved(segmentIds),
    fetchConfirmedEventRows(segmentIds),
    fetchFieldDataDayCount(segmentIds),
  ])

  const quantitiesToDate = sumByEventType(confirmedRows)
  const quantitiesThisMonth = sumByEventType(confirmedRows, currentMonthStart())

  // Deliberately no blended project-wide percentage anywhere in this module —
  // contract items are sequenced/interdependent (shoulder strip before
  // milling, milling before paving, tack coat immediately before paving,
  // hot joint sealant only where two directions meet, joint sealant only at
  // project close) and measured in incompatible units (m², tonnes, litres,
  // metres, each). There is no valid single "% complete" across them; only
  // per-item percentComplete (below) is meaningful.
  const itemsBySection = new Map<string, ItemProgress[]>()

  for (const target of targets) {
    let quantityToDate: number | null = null
    let quantityThisMonth: number | null = null
    let percentComplete: number | null = null

    if (target.eventType) {
      quantityToDate = quantitiesToDate.get(target.eventType) ?? 0
      quantityThisMonth = quantitiesThisMonth.get(target.eventType) ?? 0
      if (target.contractQty !== null && target.contractQty > 0) {
        percentComplete = (quantityToDate / target.contractQty) * 100
      }
    }

    const progress: ItemProgress = { target, quantityToDate, quantityThisMonth, percentComplete }
    const list = itemsBySection.get(target.section)
    if (list) list.push(progress)
    else itemsBySection.set(target.section, [progress])
  }

  const stats: DashboardStats = {
    daysLogged,
    totalAreaMilledM2: totalArea,
    totalTonnesPaved: totalTonnes,
  }

  return { project, stats, itemsBySection }
}
