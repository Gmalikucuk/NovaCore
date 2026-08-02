import { supabase } from './client'
import type { QueuedDailyEntry } from '../db'

export { isLumpUnit } from '../lineItemUnits'

interface RawEntryRow {
  id: string
  project_id: string
  line_item_id: string
  entry_date: string
  location: string | null
  quantity: string
  note: string | null
  status: 'draft' | 'confirmed'
  supersedes: string | null
  confirmed_by: string | null
  confirmed_at: string | null
  created_by: string
  device_id: string | null
  created_at: string
  synced_at: string
  station_from: string | null
  station_to: string | null
}

const ENTRY_SELECT =
  'id, project_id, line_item_id, entry_date, location, quantity, note, status, supersedes, confirmed_by, confirmed_at, created_by, device_id, created_at, synced_at, station_from, station_to'

function mapEntryRow(row: RawEntryRow): Omit<QueuedDailyEntry, 'pending' | 'lastError'> {
  return {
    id: row.id,
    projectId: row.project_id,
    lineItemId: row.line_item_id,
    entryDate: row.entry_date,
    location: row.location,
    quantity: Number(row.quantity),
    note: row.note,
    status: row.status,
    supersedes: row.supersedes,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    createdBy: row.created_by,
    deviceId: row.device_id,
    createdAt: row.created_at,
    syncedAt: row.synced_at,
    stationFrom: row.station_from === null ? null : Number(row.station_from),
    stationTo: row.station_to === null ? null : Number(row.station_to),
  }
}

/** Every daily_entries row for a project, server-confirmed. RLS scopes this to projects the caller is a member of. */
export async function fetchProjectEntries(projectId: string): Promise<Omit<QueuedDailyEntry, 'pending' | 'lastError'>[]> {
  const { data, error } = await supabase.from('daily_entries').select(ENTRY_SELECT).eq('project_id', projectId)
  if (error) throw error
  return (data ?? []).map((row) => mapEntryRow(row as unknown as RawEntryRow))
}

/** Scoped to one date — the desktop Manual Daily Entry screen's day view, entering a single day's rows without pulling the whole project's history. */
export async function fetchEntriesForDate(
  projectId: string,
  entryDate: string,
): Promise<Omit<QueuedDailyEntry, 'pending' | 'lastError'>[]> {
  const { data, error } = await supabase
    .from('daily_entries')
    .select(ENTRY_SELECT)
    .eq('project_id', projectId)
    .eq('entry_date', entryDate)
  if (error) throw error
  return (data ?? []).map((row) => mapEntryRow(row as unknown as RawEntryRow))
}

/** Distinct free-text location values already used on this project, for the location field's autocomplete. No sites table in v1 (spec amendment, 2026-07-30). */
export async function fetchDistinctLocations(projectId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('daily_entries')
    .select('location')
    .eq('project_id', projectId)
    .not('location', 'is', null)
  if (error) throw error
  const values = new Set((data ?? []).map((row) => row.location as string).filter(Boolean))
  return [...values].sort()
}

/**
 * Pushes one locally-queued entry to the server. Uses upsert with
 * ignoreDuplicates (Prefer: resolution=ignore-duplicates) rather than a
 * plain insert — id is client-generated (spec §3), so a retried sync must
 * be a no-op if the row already landed, not a unique-violation error.
 * Returns the row as the server has it (freshly inserted, or already
 * there) so the caller can reconcile synced_at/created_at.
 */
export async function pushDailyEntry(
  entry: Omit<QueuedDailyEntry, 'pending' | 'lastError'>,
): Promise<Omit<QueuedDailyEntry, 'pending' | 'lastError'> | null> {
  const { error } = await supabase
    .from('daily_entries')
    .upsert(
      {
        id: entry.id,
        project_id: entry.projectId,
        line_item_id: entry.lineItemId,
        entry_date: entry.entryDate,
        location: entry.location,
        quantity: entry.quantity,
        note: entry.note,
        supersedes: entry.supersedes,
        created_by: entry.createdBy,
        device_id: entry.deviceId,
        station_from: entry.stationFrom,
        station_to: entry.stationTo,
      },
      { onConflict: 'id', ignoreDuplicates: true },
    )
  if (error) throw error

  // ignoreDuplicates suppresses the representation on a real conflict, so a
  // second read confirms what's actually there either way.
  const { data, error: readError } = await supabase.from('daily_entries').select(ENTRY_SELECT).eq('id', entry.id).maybeSingle()
  if (readError) throw readError
  return data ? mapEntryRow(data as unknown as RawEntryRow) : null
}

/** Confirms a draft entry — project_manager only, per RLS (entries_confirm_pm). confirmed_by/confirmed_at are server-assigned regardless of what's sent (see guard_entry_transitions). */
export async function confirmDailyEntry(id: string): Promise<void> {
  const { error } = await supabase.from('daily_entries').update({ status: 'confirmed' }).eq('id', id)
  if (error) throw error
}
