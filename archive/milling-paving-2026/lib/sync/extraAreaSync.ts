import { db, type QueuedExtraAreaEntry } from '../db'
import { fetchTodaysExtraAreaEvents, insertExtraAreaEvent } from '../supabase/lifecycleEvents'

/**
 * Same offline-queue shape as widthReadingsSync.ts, applied to
 * surface_lifecycle_events "extra area" rows instead of width_readings.
 * Entity-generic (no milling/paving assumptions baked in) — whatever screen
 * calls enqueueExtraAreaEvent just needs a road_segment_id and a date.
 */

/** Pulls today's server-confirmed extra-area rows into the local queue table (as 'synced'), so the running list always reads from one local source. */
export async function importServerExtraAreaEvents(roadSegmentId: string, date: string): Promise<void> {
  const serverRows = await fetchTodaysExtraAreaEvents(roadSegmentId, date)
  for (const row of serverRows) {
    const existing = await db.extraAreaQueue.where('serverId').equals(row.id).first()
    if (existing) {
      // Keep the local copy's review status in sync with review-queue
      // actions taken elsewhere (e.g. a PM confirming from the desktop).
      await db.extraAreaQueue.update(existing.localId!, {
        reviewStatus: row.reviewStatus,
        quantity: row.quantity,
        eventType: row.eventType,
        fromStation: row.fromStation,
        toStation: row.toStation,
      })
      continue
    }
    await db.extraAreaQueue.add({
      serverId: row.id,
      roadSegmentId,
      date,
      eventType: row.eventType,
      quantity: row.quantity,
      locationDescription: row.locationDescription,
      station: row.fromStation === row.toStation ? row.fromStation : null,
      fromStation: row.fromStation,
      toStation: row.toStation,
      fieldNarrative: row.fieldNarrative,
      reviewStatus: row.reviewStatus,
      status: 'synced',
      lastError: null,
      createdAt: new Date(row.createdAt).getTime(),
    })
  }
}

/** Queues a brand-new extra-area entry immediately (optimistic UI), then attempts to sync it right away. */
export async function enqueueExtraAreaEvent(entry: {
  roadSegmentId: string
  date: string
  eventType: string
  quantity: number
  locationDescription: string
  /** Field-entered station, if given. Optional — from_station/to_station fall back to the segment's own bounds when omitted. */
  station: number | null
  fieldNarrative: string | null
  segmentFromStation: number
  segmentToStation: number
}): Promise<void> {
  const fromStation = entry.station ?? entry.segmentFromStation
  const toStation = entry.station ?? entry.segmentToStation

  await db.extraAreaQueue.add({
    serverId: null,
    roadSegmentId: entry.roadSegmentId,
    date: entry.date,
    eventType: entry.eventType,
    quantity: entry.quantity,
    locationDescription: entry.locationDescription,
    station: entry.station,
    fromStation,
    toStation,
    fieldNarrative: entry.fieldNarrative,
    reviewStatus: null,
    status: 'queued',
    lastError: null,
    createdAt: Date.now(),
  })

  void syncQueuedExtraAreaEvents()
}

/** Attempts to push every currently-queued extra-area entry to Supabase. Safe to call repeatedly — entries already synced are skipped. */
export async function syncQueuedExtraAreaEvents(): Promise<void> {
  const pending = await db.extraAreaQueue.where('status').equals('queued').sortBy('createdAt')

  for (const item of pending) {
    try {
      const inserted = await insertExtraAreaEvent({
        roadSegmentId: item.roadSegmentId,
        date: item.date,
        eventType: item.eventType,
        quantity: item.quantity,
        locationDescription: item.locationDescription,
        fromStation: item.fromStation,
        toStation: item.toStation,
        fieldNarrative: item.fieldNarrative,
      })
      await db.extraAreaQueue.update(item.localId!, {
        status: 'synced',
        serverId: inserted.id,
        reviewStatus: inserted.reviewStatus,
        lastError: null,
      })
    } catch (err) {
      // Left as 'queued', same reasoning as widthReadingsSync — a network
      // drop is expected and recoverable, not a permanent failure.
      await db.extraAreaQueue.update(item.localId!, {
        lastError: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

let listenersRegistered = false

/** Registers the two retry triggers (reconnect, app foreground). Safe to call multiple times — only registers once. */
export function registerExtraAreaSyncListeners(): void {
  if (listenersRegistered) return
  listenersRegistered = true

  window.addEventListener('online', () => void syncQueuedExtraAreaEvents())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncQueuedExtraAreaEvents()
  })
}

export type { QueuedExtraAreaEntry }
