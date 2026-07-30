import { db, type QueuedDailyEntry } from '../db'
import { errorMessage } from '../errorMessage'
import { fetchProjectEntries, pushDailyEntry } from '../supabase/entries'

/**
 * daily_entries is append-only, same reasoning as the archived build's
 * width_readings: there's no in-place edit to reconcile, only a queued
 * entry that failed to sync and needs retry. Mirrors widthReadingsSync.ts's
 * shape deliberately — importServerEntries (pull) / enqueueEntry (optimistic
 * local write + fire-and-forget push) / syncQueuedEntries (drain) /
 * registerSyncListeners (retry on reconnect/foreground).
 */

/** Pulls every server-confirmed row for a project into the local queue table (as pending:false), so the day list always reads from one local source. */
export async function importServerEntries(projectId: string): Promise<void> {
  const serverRows = await fetchProjectEntries(projectId)
  for (const row of serverRows) {
    await db.dailyEntries.put({ ...row, pending: false, lastError: null })
  }
}

/**
 * Queues a brand-new entry immediately (optimistic UI) with a
 * client-generated id, then attempts to sync it right away. The id is
 * decided here, not by the server (spec §3) — two offline devices can't
 * collide, and a retried push is idempotent (see pushDailyEntry's upsert).
 */
export async function enqueueEntry(entry: {
  id: string
  projectId: string
  lineItemId: string
  entryDate: string
  location: string | null
  quantity: number
  note: string | null
  supersedes: string | null
  createdBy: string
  deviceId: string | null
  stationFrom: number | null
  stationTo: number | null
}): Promise<void> {
  await db.dailyEntries.put({
    id: entry.id,
    projectId: entry.projectId,
    lineItemId: entry.lineItemId,
    entryDate: entry.entryDate,
    location: entry.location,
    quantity: entry.quantity,
    note: entry.note,
    // A correction of a confirmed entry arrives as draft — the original
    // keeps counting until the correction itself is confirmed. Never
    // silently exclude the original here; that gap is the whole reason
    // daily_entries_effective's rule exists (see 0001's own comment on it).
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
    pending: true,
    lastError: null,
  })

  void syncQueuedEntries()
}

/** Attempts to push every currently-queued entry to Supabase. Safe to call repeatedly, including on an already-synced row — pushDailyEntry's upsert makes a resend a no-op rather than a duplicate or an error. */
export async function syncQueuedEntries(): Promise<void> {
  const all = await db.dailyEntries.toArray()
  const pending = all.filter((e) => e.pending).sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  for (const item of pending) {
    try {
      const serverRow = await pushDailyEntry(item)
      if (!serverRow) {
        throw new Error('Entry not found on server after push — this should not happen.')
      }
      await db.dailyEntries.update(item.id, {
        ...serverRow,
        pending: false,
        lastError: null,
      })
    } catch (err) {
      // Left as pending — the online/visibility listeners (or the next
      // manual retry) will pick it up again.
      await db.dailyEntries.update(item.id, {
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

  window.addEventListener('online', () => void syncQueuedEntries())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncQueuedEntries()
  })
}

export type { QueuedDailyEntry }
