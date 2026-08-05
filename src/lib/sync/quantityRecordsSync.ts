import { db, type QueuedQuantityRecord } from '../db'
import { errorMessage } from '../errorMessage'
import { fetchContractQuantityRecords, pushQuantityRecord } from '../supabase/quantityRecords'

/**
 * quantity_records is append-only, same reasoning as the archived build's
 * width_readings: there's no in-place edit to reconcile, only a queued
 * record that failed to sync and needs retry. Mirrors widthReadingsSync.ts's
 * shape deliberately — importServerQuantityRecords (pull) / enqueueQuantityRecord (optimistic
 * local write + fire-and-forget push) / syncQueuedQuantityRecords (drain) /
 * registerSyncListeners (retry on reconnect/foreground).
 */

/** Pulls every server-confirmed row for a contract into the local queue table (as pending:false), so the day list always reads from one local source. */
export async function importServerQuantityRecords(contractId: string): Promise<void> {
  const serverRows = await fetchContractQuantityRecords(contractId)
  for (const row of serverRows) {
    await db.quantityRecords.put({ ...row, pending: false, lastError: null })
  }
}

/**
 * Queues a brand-new record immediately (optimistic UI) with a
 * client-generated id, then attempts to sync it right away. The id is
 * decided here, not by the server (spec §3) — two offline devices can't
 * collide, and a retried push is idempotent (see pushQuantityRecord's upsert).
 */
export async function enqueueQuantityRecord(entry: {
  id: string
  contractId: string
  itemId: string
  workDate: string
  location: string | null
  quantity: number
  note: string | null
  supersedes: string | null
  createdBy: string
  deviceId: string | null
  stationFrom: number | null
  stationTo: number | null
}): Promise<void> {
  await db.quantityRecords.put({
    id: entry.id,
    contractId: entry.contractId,
    itemId: entry.itemId,
    workDate: entry.workDate,
    location: entry.location,
    quantity: entry.quantity,
    note: entry.note,
    // A correction of a confirmed record arrives as draft — the original
    // keeps counting until the correction itself is confirmed. Never
    // silently exclude the original here; that gap is the whole reason
    // quantity_records_effective's rule exists (see 0001's own comment on it).
    status: 'draft',
    supersedes: entry.supersedes,
    confirmedBy: null,
    confirmedAt: null,
    createdBy: entry.createdBy,
    deviceId: entry.deviceId,
    createdAt: new Date().toISOString(),
    syncedAt: null,
    stationFrom: entry.stationFrom,
    stationTo: entry.stationTo,
    // Matches the server column's own default (0022) — a brand-new row has
    // never been edited yet.
    version: 1,
    pending: true,
    lastError: null,
  })

  void syncQueuedQuantityRecords()
}

/** Attempts to push every currently-queued record to Supabase. Safe to call repeatedly, including on an already-synced row — pushQuantityRecord's upsert makes a resend a no-op rather than a duplicate or an error. */
export async function syncQueuedQuantityRecords(): Promise<void> {
  const all = await db.quantityRecords.toArray()
  const pending = all.filter((e) => e.pending).sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  for (const item of pending) {
    try {
      const serverRow = await pushQuantityRecord(item)
      if (!serverRow) {
        throw new Error('Record not found on server after push — this should not happen.')
      }
      await db.quantityRecords.update(item.id, {
        ...serverRow,
        pending: false,
        lastError: null,
      })
    } catch (err) {
      // Left as pending — the online/visibility listeners (or the next
      // manual retry) will pick it up again.
      await db.quantityRecords.update(item.id, {
        lastError: errorMessage(err),
      })
    }
  }
}

let listenersRegistered = false

/** Registers the two retry triggers (reconnect, app foreground). Safe to call multiple times — only registers once. */
export function registerSyncListeners(): void {
  if (listenersRegistered) return
  listenersRegistered = true

  window.addEventListener('online', () => void syncQueuedQuantityRecords())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncQueuedQuantityRecords()
  })
}

export type { QueuedQuantityRecord }
