import { db, type QueuedWidthReading } from '../db'
import {
  fetchTodaysWidthReadings,
  insertWidthReading,
  supersedeWidthReading,
} from '../supabase/milling'

/**
 * width_readings is append-only (no in-place edits — only supersede via the
 * existing is_correction/superseded_by/correction_reason columns and role
 * gate), so there is no real "merge conflict" to resolve here. The only
 * failure mode is a queued entry failing to sync (network drop, transient
 * server error), which just needs retry — never two divergent versions of
 * the same row to reconcile.
 *
 * Shared by both Milling and Paving's entry screens — every function here
 * takes `activity` explicitly rather than assuming 'milling', since both
 * activities' readings now live in the same width_readings table (see the
 * activity column migration) and the same local Dexie queue.
 */

/** Pulls today's server-confirmed rows into the local queue table (as 'synced'), so the running list always reads from one local source. */
export async function importServerReadings(activity: 'milling' | 'paving', roadSegmentId: string, date: string): Promise<void> {
  const serverRows = await fetchTodaysWidthReadings(activity, roadSegmentId, date)
  for (const row of serverRows) {
    const existing = await db.widthReadingsQueue.where('serverId').equals(row.id).first()
    if (existing) {
      // Keep the local copy in sync with server-side changes made elsewhere
      // (e.g. a correction from another device).
      await db.widthReadingsQueue.update(existing.localId!, {
        supersededBy: row.supersededBy,
        isVoided: row.isVoided,
        correctionReason: row.correctionReason,
        isCorrection: row.isCorrection,
      })
      continue
    }
    await db.widthReadingsQueue.add({
      serverId: row.id,
      activity,
      roadSegmentId,
      direction: row.direction,
      date,
      stationSequence: row.stationSequence,
      station: row.station,
      width: row.width,
      isCorrection: row.isCorrection,
      supersededBy: row.supersededBy,
      isVoided: row.isVoided,
      correctionReason: row.correctionReason,
      status: 'synced',
      lastError: null,
      createdAt: new Date(row.entryTimestamp).getTime(),
    })
  }
}

/**
 * Queues a brand-new field entry immediately (optimistic UI), then attempts
 * to sync it right away. stationSequence here is a LOCAL-ONLY guess for
 * offline ordering/display before sync — the server is the sole source of
 * truth for the persisted value (assigned atomically by a DB trigger, see
 * migration 20260714180000) and always overwrites it on insert. Once synced,
 * syncQueuedWidthReadings reconciles this row with whatever the server
 * actually assigned, so a collision with another device's concurrent entry
 * never leaves the local copy out of sync with reality.
 */
export async function enqueueWidthReading(entry: {
  activity: 'milling' | 'paving'
  roadSegmentId: string
  direction: string
  date: string
  station: number
  width: number
}): Promise<void> {
  const existingCount = await db.widthReadingsQueue
    .where('roadSegmentId')
    .equals(entry.roadSegmentId)
    .filter((r) => r.activity === entry.activity && r.date === entry.date && !r.isCorrection)
    .count()

  await db.widthReadingsQueue.add({
    serverId: null,
    activity: entry.activity,
    roadSegmentId: entry.roadSegmentId,
    direction: entry.direction,
    date: entry.date,
    stationSequence: existingCount + 1,
    station: entry.station,
    width: entry.width,
    isCorrection: false,
    supersededBy: null,
    isVoided: false,
    correctionReason: null,
    status: 'queued',
    lastError: null,
    createdAt: Date.now(),
  })

  void syncQueuedWidthReadings()
}

/** Attempts to push every currently-queued entry to Supabase. Safe to call repeatedly — entries already synced are skipped. */
export async function syncQueuedWidthReadings(): Promise<void> {
  const pending = await db.widthReadingsQueue.where('status').equals('queued').sortBy('createdAt')

  for (const item of pending) {
    try {
      const inserted = await insertWidthReading({
        activity: item.activity,
        roadSegmentId: item.roadSegmentId,
        direction: item.direction,
        date: item.date,
        stationSequence: item.stationSequence,
        station: item.station,
        width: item.width,
      })
      await db.widthReadingsQueue.update(item.localId!, {
        status: 'synced',
        serverId: inserted.id,
        // The server may have assigned a different sequence than our local
        // guess (e.g. another device's entry for the same segment/day/
        // direction landed in between) — always take the authoritative
        // value back, so the local copy this screen actually renders from
        // can't drift from what's really stored.
        stationSequence: inserted.stationSequence,
        lastError: null,
      })
    } catch (err) {
      // Left as 'queued' — the online/visibility listeners (or the next
      // manual retry) will pick it up again. Not marked 'error' since a
      // network drop is expected and recoverable, not a permanent failure.
      await db.widthReadingsQueue.update(item.localId!, {
        lastError: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/** Applies a correction: writes both Supabase operations, then mirrors the result into the local queue so the UI updates immediately without a refetch. Requires connectivity — corrections aren't queued offline in this milestone. */
export async function applyCorrection(params: {
  original: QueuedWidthReading
  correctedStation: number
  correctedWidth: number
  reason: string
}): Promise<void> {
  const { original } = params
  if (!original.serverId) {
    throw new Error('Cannot correct an entry that has not synced yet — wait for it to sync first.')
  }

  const corrected = await supersedeWidthReading({
    originalId: original.serverId,
    activity: original.activity,
    roadSegmentId: original.roadSegmentId,
    direction: original.direction,
    date: original.date,
    stationSequence: original.stationSequence,
    correctedStation: params.correctedStation,
    correctedWidth: params.correctedWidth,
    reason: params.reason,
  })

  await db.widthReadingsQueue.update(original.localId!, {
    supersededBy: corrected.id,
    correctionReason: params.reason,
  })

  await db.widthReadingsQueue.add({
    serverId: corrected.id,
    activity: original.activity,
    roadSegmentId: original.roadSegmentId,
    direction: original.direction,
    date: original.date,
    stationSequence: corrected.stationSequence,
    station: corrected.station,
    width: corrected.width,
    isCorrection: true,
    supersededBy: null,
    isVoided: false,
    correctionReason: params.reason,
    status: 'synced',
    lastError: null,
    createdAt: new Date(corrected.entryTimestamp).getTime(),
  })
}

let listenersRegistered = false

/** Registers the two retry triggers (reconnect, app foreground). Safe to call multiple times — only registers once. */
export function registerSyncListeners(): void {
  if (listenersRegistered) return
  listenersRegistered = true

  window.addEventListener('online', () => void syncQueuedWidthReadings())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncQueuedWidthReadings()
  })
}
