import { supabase } from './client'
import type { QueuedQuantityRecord } from '../db'

interface RawQuantityRecordRow {
  id: string
  contract_id: string
  item_id: string
  work_date: string
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

const QUANTITY_RECORD_SELECT =
  'id, contract_id, item_id, work_date, location, quantity, note, status, supersedes, confirmed_by, confirmed_at, created_by, device_id, created_at, synced_at, station_from, station_to'

function mapQuantityRecordRow(row: RawQuantityRecordRow): Omit<QueuedQuantityRecord, 'pending' | 'lastError'> {
  return {
    id: row.id,
    contractId: row.contract_id,
    itemId: row.item_id,
    workDate: row.work_date,
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

/** Every quantity_records row for a contract, server-confirmed. RLS scopes this to contracts the caller is a member of. */
export async function fetchContractQuantityRecords(contractId: string): Promise<Omit<QueuedQuantityRecord, 'pending' | 'lastError'>[]> {
  const { data, error } = await supabase.from('quantity_records').select(QUANTITY_RECORD_SELECT).eq('contract_id', contractId)
  if (error) throw error
  return (data ?? []).map((row) => mapQuantityRecordRow(row as unknown as RawQuantityRecordRow))
}

/** Scoped to one date — the desktop Manual Daily Entry screen's day view, entering a single day's rows without pulling the whole contract's history. */
export async function fetchQuantityRecordsForDate(
  contractId: string,
  workDate: string,
): Promise<Omit<QueuedQuantityRecord, 'pending' | 'lastError'>[]> {
  const { data, error } = await supabase
    .from('quantity_records')
    .select(QUANTITY_RECORD_SELECT)
    .eq('contract_id', contractId)
    .eq('work_date', workDate)
  if (error) throw error
  return (data ?? []).map((row) => mapQuantityRecordRow(row as unknown as RawQuantityRecordRow))
}

/** Distinct free-text location values already used on this contract, for the location field's autocomplete. No sites table in v1 (spec amendment, 2026-07-30). */
export async function fetchDistinctLocations(contractId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('quantity_records')
    .select('location')
    .eq('contract_id', contractId)
    .not('location', 'is', null)
  if (error) throw error
  const values = new Set((data ?? []).map((row) => row.location as string).filter(Boolean))
  return [...values].sort()
}

/**
 * Pushes one locally-queued record to the server. Uses upsert with
 * ignoreDuplicates (Prefer: resolution=ignore-duplicates) rather than a
 * plain insert — id is client-generated (spec §3), so a retried sync must
 * be a no-op if the row already landed, not a unique-violation error.
 * Returns the row as the server has it (freshly inserted, or already
 * there) so the caller can reconcile synced_at/created_at.
 */
export async function pushQuantityRecord(
  entry: Omit<QueuedQuantityRecord, 'pending' | 'lastError'>,
): Promise<Omit<QueuedQuantityRecord, 'pending' | 'lastError'> | null> {
  const { error } = await supabase
    .from('quantity_records')
    .upsert(
      {
        id: entry.id,
        contract_id: entry.contractId,
        item_id: entry.itemId,
        work_date: entry.workDate,
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
  const { data, error: readError } = await supabase.from('quantity_records').select(QUANTITY_RECORD_SELECT).eq('id', entry.id).maybeSingle()
  if (readError) throw readError
  return data ? mapQuantityRecordRow(data as unknown as RawQuantityRecordRow) : null
}

/** Confirms a draft record — project_manager only, per RLS (quantity_records_confirm_right). confirmed_by/confirmed_at are server-assigned regardless of what's sent (see guard_entry_transitions). */
export async function confirmQuantityRecord(id: string): Promise<void> {
  const { error } = await supabase.from('quantity_records').update({ status: 'confirmed' }).eq('id', id)
  if (error) throw error
}

// ─────────────────────────────────────────────────────────────────────────
// PM confirmation queue — every draft record across the whole contract
// (not scoped to one work_date, unlike fetchQuantityRecordsForDate above),
// with the Item and correction context joined in so the queue screen never
// needs a second round-trip per record.
// ─────────────────────────────────────────────────────────────────────────

export interface PendingQuantityRecord {
  id: string
  itemId: string
  itemNumber: string
  description: string
  unit: string
  approximateQuantity: number
  workDate: string
  location: string | null
  quantity: number
  note: string | null
  stationFrom: number | null
  stationTo: number | null
  supersedes: string | null
  /** The quantity currently counted from the record this one supersedes — null unless this is a correction AND the original was itself confirmed (an unconfirmed original counts for nothing today, so there's nothing to subtract/compare). */
  originalQuantity: number | null
  createdBy: string
  createdByName: string | null
}

interface RawPendingRow {
  id: string
  item_id: string
  work_date: string
  location: string | null
  quantity: string
  note: string | null
  station_from: string | null
  station_to: string | null
  supersedes: string | null
  created_by: string
  items: { item_number: string; description: string; unit: string; approximate_quantity: string } | null
  creator: { full_name: string | null } | null
}

/** Just the count of draft records — the Sidebar nav badge's source, cheaper than fetching every row when only the number is shown. */
export async function fetchPendingQuantityRecordCount(contractId: string): Promise<number> {
  const { count, error } = await supabase.from('quantity_records').select('id', { count: 'exact', head: true }).eq('contract_id', contractId).eq('status', 'draft')
  if (error) throw error
  return count ?? 0
}

/** Every draft (unconfirmed) quantity_records row on the contract — the PM confirmation queue's source list. RLS scopes this to contracts the caller is a member of; the confirm_quantity gate is enforced on the write (confirmQuantityRecord), not the read. */
export async function fetchPendingQuantityRecords(contractId: string): Promise<PendingQuantityRecord[]> {
  const { data, error } = await supabase
    .from('quantity_records')
    .select(
      'id, item_id, work_date, location, quantity, note, station_from, station_to, supersedes, created_by, ' +
        'items!inner ( item_number, description, unit, approximate_quantity ), ' +
        'creator:profiles!created_by ( full_name )',
    )
    .eq('contract_id', contractId)
    .eq('status', 'draft')
    .order('work_date', { ascending: false })
  if (error) throw error

  const rows = (data ?? []) as unknown as RawPendingRow[]

  // The "original" (what a correction supersedes) is deliberately a SEPARATE
  // query, not a self-referencing embed — quantity_records!supersedes is a
  // self-join, and PostgREST resolves a bare `!supersedes` hint as the
  // reverse (one-to-many: "rows that supersede me") rather than the forward
  // direction this needed ("the row my own supersedes column points at"),
  // silently returning the wrong record. An explicit .in() lookup has no
  // such ambiguity.
  const originalIds = [...new Set(rows.map((r) => r.supersedes).filter((id): id is string => id !== null))]
  const originalById = new Map<string, { quantity: number; status: 'draft' | 'confirmed' }>()
  if (originalIds.length > 0) {
    const { data: originals, error: originalsError } = await supabase.from('quantity_records').select('id, quantity, status').in('id', originalIds)
    if (originalsError) throw originalsError
    for (const o of originals ?? []) {
      originalById.set(o.id as string, { quantity: Number(o.quantity), status: o.status as 'draft' | 'confirmed' })
    }
  }

  return rows.map((r) => {
    const original = r.supersedes ? originalById.get(r.supersedes) : undefined
    return {
      id: r.id,
      itemId: r.item_id,
      itemNumber: r.items?.item_number ?? '',
      description: r.items?.description ?? '',
      unit: r.items?.unit ?? '',
      approximateQuantity: r.items ? Number(r.items.approximate_quantity) : 0,
      workDate: r.work_date,
      location: r.location,
      quantity: Number(r.quantity),
      note: r.note,
      stationFrom: r.station_from === null ? null : Number(r.station_from),
      stationTo: r.station_to === null ? null : Number(r.station_to),
      supersedes: r.supersedes,
      originalQuantity: original && original.status === 'confirmed' ? original.quantity : null,
      createdBy: r.created_by,
      createdByName: r.creator?.full_name ?? null,
    }
  })
}
