import { isRangeFullyCovered, mergeIntervals, type Interval } from '../calculations/intervalCoverage'
import { calculateSegments, cumulativeArea } from '../calculations/segmentArea'
import { splitIntoThreads } from '../calculations/sessionThreads'
import { supabase } from './client'

export interface ProjectOption {
  id: string
  contractNumber: string
  name: string
}

export interface SegmentCandidate {
  id: string
  direction: 'NB' | 'SB' | 'EB' | 'WB'
  fromStation: number
  toStation: number
  highway2FromStation: number | null
  highway2ToStation: number | null
  highway: string
}

export interface CurrentCrewMember {
  id: string
  name: string
  role: string
}

export interface WidthReadingRow {
  id: string
  direction: string
  stationSequence: number
  station: number
  width: number
  isCorrection: boolean
  supersededBy: string | null
  isVoided: boolean
  correctionReason: string | null
  entryTimestamp: string
}

export async function fetchProjects(): Promise<ProjectOption[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, contract_number, name')
    .order('contract_number')
  if (error) throw error
  return (data ?? []).map((row) => ({
    id: row.id,
    contractNumber: row.contract_number,
    name: row.name,
  }))
}

/**
 * All road_segments (both directions, every segment group) for a project,
 * in one call — the raw material segmentResolution.ts resolves a typed
 * station against. Deliberately not scoped to a single segment group: the
 * resolver itself decides which candidate a station belongs to (preferring
 * whichever segment is currently active), so the UI no longer needs the
 * person to manually pick a segment group/direction pair up front.
 */
export async function fetchProjectSegmentCandidates(projectId: string): Promise<SegmentCandidate[]> {
  const { data, error } = await supabase
    .from('road_segments')
    .select(
      'id, direction, from_station, to_station, highway_2_from_station, highway_2_to_station, road_segment_groups!inner(highway, jobs!inner(project_id))',
    )
    .eq('road_segment_groups.jobs.project_id', projectId)
  if (error) throw error
  return (data ?? []).map((row) => ({
    id: row.id,
    direction: row.direction,
    fromStation: Number(row.from_station),
    toStation: Number(row.to_station),
    highway2FromStation: row.highway_2_from_station === null ? null : Number(row.highway_2_from_station),
    highway2ToStation: row.highway_2_to_station === null ? null : Number(row.highway_2_to_station),
    highway: (row.road_segment_groups as unknown as { highway: string }).highway,
  }))
}

export async function fetchCurrentCrewMember(): Promise<CurrentCrewMember | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data, error } = await supabase
    .from('crew_members')
    .select('id, name, role')
    .eq('auth_user_id', user.id)
    .maybeSingle()
  if (error) throw error
  return data
}

const WIDTH_READING_SELECT =
  'id, direction, station_sequence, station, width, is_correction, superseded_by, is_voided, correction_reason, entry_timestamp'

function mapWidthReadingRow(row: {
  id: string
  direction: string
  station_sequence: number
  station: number
  width: number
  is_correction: boolean
  superseded_by: string | null
  is_voided: boolean
  correction_reason: string | null
  entry_timestamp: string
}): WidthReadingRow {
  return {
    id: row.id,
    direction: row.direction,
    stationSequence: row.station_sequence,
    station: Number(row.station),
    width: Number(row.width),
    isCorrection: row.is_correction,
    supersededBy: row.superseded_by,
    isVoided: row.is_voided,
    correctionReason: row.correction_reason,
    entryTimestamp: row.entry_timestamp,
  }
}

export interface MillingReferenceReading {
  station: number
  width: number
}

/**
 * Milling's own active readings for a segment (any date, station+width
 * only) — the raw material for the milled-width reference display on
 * Paving's entry screen (see milledWidthReference.ts). Always
 * activity='milling' regardless of who's asking — Paving looks up
 * MILLING's readings specifically, never its own.
 */
export async function fetchMillingReferenceReadings(roadSegmentId: string): Promise<MillingReferenceReading[]> {
  const { data, error } = await supabase
    .from('width_readings')
    .select('station, width')
    .eq('activity', 'milling')
    .eq('road_segment_id', roadSegmentId)
    .is('superseded_by', null)
    .eq('is_voided', false)
  if (error) throw error
  return (data ?? []).map((row) => ({ station: Number(row.station), width: Number(row.width) }))
}

export async function fetchTodaysWidthReadings(
  activity: string,
  roadSegmentId: string,
  date: string,
): Promise<WidthReadingRow[]> {
  const { data, error } = await supabase
    .from('width_readings')
    .select(WIDTH_READING_SELECT)
    .eq('activity', activity)
    .eq('road_segment_id', roadSegmentId)
    .eq('paving_date', date)
    .order('station_sequence', { ascending: true })
  if (error) throw error
  return (data ?? []).map(mapWidthReadingRow)
}

async function queryStationCoverageIntervals(
  activity: string,
  roadSegmentId: string,
  excludeDate?: string,
): Promise<Interval[]> {
  let query = supabase
    .from('width_readings')
    .select('paving_date, station')
    .eq('activity', activity)
    .eq('road_segment_id', roadSegmentId)
    .is('superseded_by', null)
    .eq('is_voided', false)
  if (excludeDate) query = query.neq('paving_date', excludeDate)
  const { data, error } = await query
  if (error) throw error

  const byDate = new Map<string, number[]>()
  for (const row of data ?? []) {
    const stations = byDate.get(row.paving_date)
    if (stations) stations.push(Number(row.station))
    else byDate.set(row.paving_date, [Number(row.station)])
  }

  return [...byDate.values()].map((stations) => ({
    lo: Math.min(...stations),
    hi: Math.max(...stations),
  }))
}

/**
 * One [min station, max station] interval per prior day that has active
 * (non-superseded) readings for this segment — the raw material for the
 * merge in intervalCoverage.ts. Excludes `excludeDate` (today) since that
 * day's coverage is computed live from the local Dexie queue instead, which
 * reflects not-yet-synced entries this server fetch wouldn't have yet.
 * activity scopes this to one activity's own readings — Paving's coverage
 * check reads this with activity='milling' to validate against MILLING's
 * coverage (see Stage 1 spec), never its own.
 */
export async function fetchStationCoverageIntervals(
  activity: string,
  roadSegmentId: string,
  excludeDate: string,
): Promise<Interval[]> {
  return queryStationCoverageIntervals(activity, roadSegmentId, excludeDate)
}

/**
 * Same shape as fetchStationCoverageIntervals but across every date,
 * including today — used to decide whether a past session's segment+
 * direction is now fully covered end to end (so its "Continue from here"
 * resume icon can be hidden), which needs the complete confirmed-reading
 * picture, not just history before some particular day.
 */
export async function fetchFullStationCoverageIntervals(activity: string, roadSegmentId: string): Promise<Interval[]> {
  return queryStationCoverageIntervals(activity, roadSegmentId)
}

export async function insertWidthReading(params: {
  activity: string
  roadSegmentId: string
  direction: string
  date: string
  stationSequence: number
  station: number
  width: number
}): Promise<WidthReadingRow> {
  // entered_by is deliberately omitted — the server derives it from
  // auth.uid() via the DEFAULT + BEFORE INSERT trigger set up earlier; the
  // client never asserts who performed the entry.
  const { data, error } = await supabase
    .from('width_readings')
    .insert({
      activity: params.activity,
      road_segment_id: params.roadSegmentId,
      direction: params.direction,
      paving_date: params.date,
      station_sequence: params.stationSequence,
      station: params.station,
      width: params.width,
    })
    .select(WIDTH_READING_SELECT)
    .single()
  if (error) throw error
  return mapWidthReadingRow(data)
}

/**
 * Corrects an existing width_reading via the append-only supersede
 * workflow: insert a brand-new row with the corrected values, then point
 * the original at it. The original's row is never edited in place.
 *
 * The corrected row reuses the original's station_sequence — superseded
 * rows are always filtered out before any area calculation, so there's no
 * ordering conflict; the correction simply takes over that slot in the
 * field-entry sequence rather than getting appended at the end (which
 * would put it in the wrong position relative to readings taken after it).
 *
 * The second step (setting the original's superseded_by) is role-gated at
 * the database level: only the crew member who entered the original, or a
 * coordinator, may do this. A caller without that permission gets a clear
 * Postgres error, not a silent partial success — though note this does
 * leave the new row inserted even if the second step is rejected; the
 * caller should surface the error so the user knows the correction didn't
 * fully take effect.
 */
export async function supersedeWidthReading(params: {
  originalId: string
  activity: string
  roadSegmentId: string
  direction: string
  date: string
  stationSequence: number
  correctedStation: number
  correctedWidth: number
  reason: string
}): Promise<WidthReadingRow> {
  const { data: inserted, error: insertError } = await supabase
    .from('width_readings')
    .insert({
      activity: params.activity,
      road_segment_id: params.roadSegmentId,
      direction: params.direction,
      paving_date: params.date,
      station_sequence: params.stationSequence,
      station: params.correctedStation,
      width: params.correctedWidth,
      is_correction: true,
      correction_reason: params.reason,
    })
    .select(WIDTH_READING_SELECT)
    .single()
  if (insertError) throw insertError

  const { error: updateError } = await supabase
    .from('width_readings')
    .update({ superseded_by: inserted.id, correction_reason: params.reason })
    .eq('id', params.originalId)
  if (updateError) throw updateError

  return mapWidthReadingRow(inserted)
}

/**
 * Voids a reading in place — no new row, unlike a correction. Role-gated
 * server-side identically to superseded_by (original enterer or
 * coordinator only, see enforce_width_readings_update_columns), and
 * correction_reason is required by the same check constraint that already
 * covers is_correction/superseded_by. The row is never deleted or hidden;
 * callers exclude is_voided rows from area/coverage math but keep showing
 * them (struck through) in any reading list.
 */
export async function voidWidthReading(readingId: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from('width_readings')
    .update({ is_voided: true, correction_reason: reason })
    .eq('id', readingId)
  if (error) throw error
}

/**
 * Inserts a reading between afterReadingId and whatever currently follows
 * it, via the insert_width_reading_between DB function (see migration
 * 20260716200000) — the fractional station_sequence value is computed and
 * assigned entirely server-side, atomically, under the same per-group
 * advisory lock a normal append uses. If there's no room left between two
 * neighbors (they're already as close as the numeric(10,3) column allows),
 * the function raises a specific "No room left..." error rather than a raw
 * constraint violation, which surfaces here as a normal thrown Error via
 * PostgREST's error.message — callers don't need to special-case it.
 */
export async function insertWidthReadingBetween(
  afterReadingId: string,
  station: number,
  width: number,
): Promise<WidthReadingRow> {
  const { data, error } = await supabase.rpc('insert_width_reading_between', {
    after_reading_id: afterReadingId,
    new_station: station,
    new_width: width,
  })
  if (error) throw error
  return mapWidthReadingRow(data)
}

/**
 * Mirror of insertWidthReadingBetween, via insert_width_reading_before (see
 * migration 20260719100000) — same atomic, server-side sequence assignment,
 * just computing the midpoint against the PRIOR neighbor instead of the
 * next one. Inserting before the first reading in a session falls back to
 * one below the current minimum rather than a midpoint, entirely inside
 * the DB function — nothing for this call site to special-case.
 */
export async function insertWidthReadingBefore(
  beforeReadingId: string,
  station: number,
  width: number,
): Promise<WidthReadingRow> {
  const { data, error } = await supabase.rpc('insert_width_reading_before', {
    before_reading_id: beforeReadingId,
    new_station: station,
    new_width: width,
  })
  if (error) throw error
  return mapWidthReadingRow(data)
}

export interface PastReadingRow {
  id: string
  roadSegmentId: string
  direction: string
  date: string
  stationSequence: number
  station: number
  width: number
  isCorrection: boolean
  supersededBy: string | null
  isVoided: boolean
  correctionReason: string | null
  entryTimestamp: string
  highway: string
  projectId: string
  projectContractNumber: string
  projectName: string
}

export interface DaySegmentGroup {
  roadSegmentId: string
  direction: string
  highway: string
  projectContractNumber: string
  projectName: string
  area: number
  readings: PastReadingRow[]
}

/**
 * One independently-resumable past session: every reading for one segment
 * on one date that shares a single direction-of-travel thread (see
 * sessionThreads.ts — a thread breaks wherever the station order reverses,
 * since a segment-cut exception is the only real-world reason a crew
 * restarts elsewhere on the same segment/day). A day with three distinct
 * sessions produces three of these, each independently resumable, rather
 * than being collapsed into one calendar-day summary.
 */
export interface PastSessionGroup {
  key: string
  date: string
  projectId: string
  projectContractNumber: string
  projectName: string
  roadSegmentId: string
  direction: string
  highway: string
  ascendingDescending: 'ascending' | 'descending' | null
  startingStation: number
  area: number
  readingCount: number
  fullyCovered: boolean
}

const PAST_READING_SELECT = `
  id, road_segment_id, direction, paving_date, station_sequence, station, width,
  is_correction, superseded_by, is_voided, correction_reason, entry_timestamp,
  road_segments!inner ( from_station, to_station, road_segment_groups!inner ( highway, jobs!inner ( projects!inner ( id, contract_number, name ) ) ) )
`

interface RawPastReadingRow {
  id: string
  road_segment_id: string
  direction: string
  paving_date: string
  station_sequence: number
  station: number
  width: number
  is_correction: boolean
  superseded_by: string | null
  is_voided: boolean
  correction_reason: string | null
  entry_timestamp: string
  road_segments: {
    from_station: number
    to_station: number
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

function mapPastReadingRow(row: RawPastReadingRow): PastReadingRow {
  const group = row.road_segments.road_segment_groups
  const project = group.jobs.projects
  return {
    id: row.id,
    roadSegmentId: row.road_segment_id,
    direction: row.direction,
    date: row.paving_date,
    stationSequence: row.station_sequence,
    station: Number(row.station),
    width: Number(row.width),
    isCorrection: row.is_correction,
    supersededBy: row.superseded_by,
    isVoided: row.is_voided,
    correctionReason: row.correction_reason,
    entryTimestamp: row.entry_timestamp,
    highway: group.highway,
    projectId: project.id,
    projectContractNumber: project.contract_number,
    projectName: project.name,
  }
}

function groupBySegment(rows: PastReadingRow[]): Map<string, PastReadingRow[]> {
  const bySegment = new Map<string, PastReadingRow[]>()
  for (const row of rows) {
    const existing = bySegment.get(row.roadSegmentId)
    if (existing) existing.push(row)
    else bySegment.set(row.roadSegmentId, [row])
  }
  return bySegment
}

/**
 * Every past session (see PastSessionGroup) for one project's segments,
 * before `excludeDate` (today — today's entries live in the active session
 * view, not "previous days"). Scoped to `projectId` — the caller's current
 * project (see currentProject.ts) — so a crew working project A never sees
 * project B's sessions mixed into the same list. fullyCovered is computed
 * from the segment's complete confirmed-reading history (every date, not
 * just before excludeDate — a session resumed after the segment was later
 * finished elsewhere no longer needs a resume icon), reusing the same
 * mergeIntervals/isRangeFullyCovered logic the live entry screen's
 * no-double-entry check already uses, against the segment's declared
 * from_station/to_station range.
 */
export async function fetchPastSessionGroups(
  activity: string,
  excludeDate: string,
  projectId: string,
): Promise<PastSessionGroup[]> {
  const { data, error } = await supabase
    .from('width_readings')
    .select(PAST_READING_SELECT)
    .eq('activity', activity)
    .eq('road_segments.road_segment_groups.jobs.project_id', projectId)
    .is('superseded_by', null)
    .eq('is_voided', false)
    .neq('paving_date', excludeDate)
  if (error) throw error

  const rawRows = (data ?? []) as unknown as RawPastReadingRow[]
  const rows = rawRows.map(mapPastReadingRow)
  const segmentRange = new Map<string, { fromStation: number; toStation: number }>()
  for (const row of rawRows) {
    if (!segmentRange.has(row.road_segment_id)) {
      segmentRange.set(row.road_segment_id, {
        fromStation: Number(row.road_segments.from_station),
        toStation: Number(row.road_segments.to_station),
      })
    }
  }

  const byDateAndSegment = new Map<string, PastReadingRow[]>()
  for (const row of rows) {
    const key = `${row.date} ${row.roadSegmentId}`
    const existing = byDateAndSegment.get(key)
    if (existing) existing.push(row)
    else byDateAndSegment.set(key, [row])
  }

  const coverageCache = new Map<string, Promise<Interval[]>>()
  function coverageFor(roadSegmentId: string): Promise<Interval[]> {
    let cached = coverageCache.get(roadSegmentId)
    if (!cached) {
      cached = fetchFullStationCoverageIntervals(activity, roadSegmentId)
      coverageCache.set(roadSegmentId, cached)
    }
    return cached
  }

  const groups: PastSessionGroup[] = []
  for (const [key, segmentDateRows] of byDateAndSegment) {
    const [date, roadSegmentId] = key.split(' ')
    const sorted = [...segmentDateRows].sort((a, b) => a.stationSequence - b.stationSequence)
    const threads = splitIntoThreads(sorted)
    const range = segmentRange.get(roadSegmentId)
    const merged = mergeIntervals(await coverageFor(roadSegmentId))
    const fullyCovered = range ? isRangeFullyCovered(Math.min(range.fromStation, range.toStation), Math.max(range.fromStation, range.toStation), merged) : false

    threads.forEach((thread, threadIndex) => {
      const area =
        thread.readings.length < 2
          ? 0
          : cumulativeArea(
              calculateSegments(
                thread.readings.map((r) => ({ stationSequence: r.stationSequence, station: r.station, width: r.width })),
              ),
            )
      const first = thread.readings[0]
      const last = thread.readings[thread.readings.length - 1]
      groups.push({
        key: `${key} ${threadIndex}`,
        date,
        projectId: first.projectId,
        projectContractNumber: first.projectContractNumber,
        projectName: first.projectName,
        roadSegmentId,
        direction: first.direction,
        highway: first.highway,
        ascendingDescending: thread.direction,
        startingStation: last.station,
        area,
        readingCount: thread.readings.length,
        fullyCovered,
      })
    })
  }

  return groups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.projectContractNumber.localeCompare(b.projectContractNumber)))
}

/**
 * Full reading list for one specific date — including superseded rows, so
 * the day-detail view can show correction history the same way the live
 * entry screen's badges do — grouped by segment, since station_sequence
 * ordering is only meaningful within one segment's own continuous walk and
 * readings from different segments touched the same day can't be
 * interleaved by it.
 */
export async function fetchDayReadingGroups(activity: string, date: string): Promise<DaySegmentGroup[]> {
  const { data, error } = await supabase
    .from('width_readings')
    .select(PAST_READING_SELECT)
    .eq('activity', activity)
    .eq('paving_date', date)
  if (error) throw error

  const rows = (data ?? []).map((row) => mapPastReadingRow(row as unknown as RawPastReadingRow))

  const groups: DaySegmentGroup[] = []
  for (const [roadSegmentId, segmentRows] of groupBySegment(rows)) {
    const sorted = [...segmentRows].sort((a, b) =>
      a.stationSequence !== b.stationSequence
        ? a.stationSequence - b.stationSequence
        : a.entryTimestamp.localeCompare(b.entryTimestamp),
    )
    // Voided readings stay in `readings` (visible, struck through) but
    // never contribute to area, same as superseded ones.
    const activeRows = sorted.filter((r) => r.supersededBy === null && !r.isVoided)
    const area =
      activeRows.length < 2
        ? 0
        : cumulativeArea(
            calculateSegments(activeRows.map((r) => ({ stationSequence: r.stationSequence, station: r.station, width: r.width }))),
          )
    const first = sorted[0]
    groups.push({
      roadSegmentId,
      direction: first.direction,
      highway: first.highway,
      projectContractNumber: first.projectContractNumber,
      projectName: first.projectName,
      area,
      readings: sorted,
    })
  }

  return groups.sort((a, b) => a.projectContractNumber.localeCompare(b.projectContractNumber) || a.direction.localeCompare(b.direction))
}

/**
 * Every reading for one specific session (one segment, one date) —
 * including superseded and voided rows, so the Review Readings screen can
 * show the full history of what happened to this session, not just what's
 * currently active. Scoped directly via the query rather than reusing
 * fetchDayReadingGroups + filtering client-side, since a session review is
 * naturally keyed by (date, roadSegmentId) already and there's no reason to
 * fetch every other segment touched that same day just to discard them.
 */
export async function fetchSessionReadings(
  activity: string,
  date: string,
  roadSegmentId: string,
): Promise<DaySegmentGroup | null> {
  const { data, error } = await supabase
    .from('width_readings')
    .select(PAST_READING_SELECT)
    .eq('activity', activity)
    .eq('paving_date', date)
    .eq('road_segment_id', roadSegmentId)
  if (error) throw error

  const rows = (data ?? []).map((row) => mapPastReadingRow(row as unknown as RawPastReadingRow))
  if (rows.length === 0) return null

  const sorted = [...rows].sort((a, b) =>
    a.stationSequence !== b.stationSequence
      ? a.stationSequence - b.stationSequence
      : a.entryTimestamp.localeCompare(b.entryTimestamp),
  )
  const activeRows = sorted.filter((r) => r.supersededBy === null && !r.isVoided)
  const area =
    activeRows.length < 2
      ? 0
      : cumulativeArea(
          calculateSegments(activeRows.map((r) => ({ stationSequence: r.stationSequence, station: r.station, width: r.width }))),
        )
  const first = sorted[0]
  return {
    roadSegmentId,
    direction: first.direction,
    highway: first.highway,
    projectContractNumber: first.projectContractNumber,
    projectName: first.projectName,
    area,
    readings: sorted,
  }
}
