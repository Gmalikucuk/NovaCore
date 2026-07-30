import { db, type QueuedTruckTicket } from '../db'
import { fetchTodaysTruckTickets, insertTruckTicket, supersedeTruckTicket } from '../supabase/truckTickets'

/**
 * truck_tickets is append-only, same as width_readings (see
 * widthReadingsSync.ts's header) — no merge conflicts to resolve, only
 * queued-entry retry on network failure. Mirrors that file's shape
 * deliberately rather than reinventing it, per the Stage 2 spec.
 */

/** Pulls today's server-confirmed rows into the local queue table (as 'synced'), so the running list always reads from one local source. */
export async function importServerTruckTickets(roadSegmentId: string, date: string): Promise<void> {
  const serverRows = await fetchTodaysTruckTickets(roadSegmentId, date)
  for (const row of serverRows) {
    const existing = await db.truckTicketsQueue.where('serverId').equals(row.id).first()
    if (existing) {
      // Keep the local copy in sync with server-side changes made elsewhere
      // (e.g. a correction or void from another device).
      await db.truckTicketsQueue.update(existing.localId!, {
        supersededBy: row.supersededBy,
        isVoided: row.isVoided,
        correctionReason: row.correctionReason,
        isCorrection: row.isCorrection,
      })
      continue
    }
    await db.truckTicketsQueue.add({
      serverId: row.id,
      roadSegmentId,
      direction: row.direction,
      date,
      arrivalSequence: row.arrivalSequence,
      vehicleNumber: row.vehicleNumber,
      ticketNumber: row.ticketNumber,
      netTonnage: row.netTonnage,
      liftType: row.liftType,
      isCorrection: row.isCorrection,
      supersededBy: row.supersededBy,
      isVoided: row.isVoided,
      correctionReason: row.correctionReason,
      status: 'synced',
      lastError: null,
      createdAt: new Date(row.loggedTimestamp).getTime(),
    })
  }
}

/**
 * Queues a brand-new field entry immediately (optimistic UI), then attempts
 * to sync it right away. arrivalSequence here is a LOCAL-ONLY guess for
 * offline ordering/display before sync — the server is the sole source of
 * truth for the persisted value (assigned atomically by a DB trigger, see
 * migration 20260719120000) and always overwrites it on insert. Once synced,
 * syncQueuedTruckTickets reconciles this row with whatever the server
 * actually assigned.
 */
export async function enqueueTruckTicket(entry: {
  roadSegmentId: string
  direction: string
  date: string
  vehicleNumber: string
  ticketNumber: string
  netTonnage: number
  liftType: 'top_lift' | 'level_course'
}): Promise<void> {
  const existingCount = await db.truckTicketsQueue
    .where('roadSegmentId')
    .equals(entry.roadSegmentId)
    .filter((t) => t.date === entry.date && !t.isCorrection)
    .count()

  await db.truckTicketsQueue.add({
    serverId: null,
    roadSegmentId: entry.roadSegmentId,
    direction: entry.direction,
    date: entry.date,
    arrivalSequence: existingCount + 1,
    vehicleNumber: entry.vehicleNumber,
    ticketNumber: entry.ticketNumber,
    netTonnage: entry.netTonnage,
    liftType: entry.liftType,
    isCorrection: false,
    supersededBy: null,
    isVoided: false,
    correctionReason: null,
    status: 'queued',
    lastError: null,
    createdAt: Date.now(),
  })

  void syncQueuedTruckTickets()
}

/** Attempts to push every currently-queued entry to Supabase. Safe to call repeatedly — entries already synced are skipped. */
export async function syncQueuedTruckTickets(): Promise<void> {
  const pending = await db.truckTicketsQueue.where('status').equals('queued').sortBy('createdAt')

  for (const item of pending) {
    try {
      const inserted = await insertTruckTicket({
        roadSegmentId: item.roadSegmentId,
        direction: item.direction,
        date: item.date,
        vehicleNumber: item.vehicleNumber,
        ticketNumber: item.ticketNumber,
        netTonnage: item.netTonnage,
        liftType: item.liftType,
      })
      await db.truckTicketsQueue.update(item.localId!, {
        status: 'synced',
        serverId: inserted.id,
        // The server may have assigned a different sequence than our local
        // guess — always take the authoritative value back.
        arrivalSequence: inserted.arrivalSequence,
        lastError: null,
      })
    } catch (err) {
      // Left as 'queued' — the online/visibility listeners (or the next
      // manual retry) will pick it up again.
      await db.truckTicketsQueue.update(item.localId!, {
        lastError: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/** Applies a correction: writes both Supabase operations, then mirrors the result into the local queue so the UI updates immediately without a refetch. Requires connectivity — corrections aren't queued offline in this milestone. */
export async function applyTruckTicketCorrection(params: {
  original: QueuedTruckTicket
  correctedVehicleNumber: string
  correctedTicketNumber: string
  correctedNetTonnage: number
  correctedLiftType: 'top_lift' | 'level_course'
  reason: string
}): Promise<void> {
  const { original } = params
  if (!original.serverId) {
    throw new Error('Cannot correct an entry that has not synced yet — wait for it to sync first.')
  }

  const corrected = await supersedeTruckTicket({
    originalId: original.serverId,
    roadSegmentId: original.roadSegmentId,
    direction: original.direction,
    date: original.date,
    arrivalSequence: original.arrivalSequence,
    correctedVehicleNumber: params.correctedVehicleNumber,
    correctedTicketNumber: params.correctedTicketNumber,
    correctedNetTonnage: params.correctedNetTonnage,
    correctedLiftType: params.correctedLiftType,
    reason: params.reason,
  })

  await db.truckTicketsQueue.update(original.localId!, {
    supersededBy: corrected.id,
    correctionReason: params.reason,
  })

  await db.truckTicketsQueue.add({
    serverId: corrected.id,
    roadSegmentId: original.roadSegmentId,
    direction: original.direction,
    date: original.date,
    arrivalSequence: corrected.arrivalSequence,
    vehicleNumber: corrected.vehicleNumber,
    ticketNumber: corrected.ticketNumber,
    netTonnage: corrected.netTonnage,
    liftType: corrected.liftType,
    isCorrection: true,
    supersededBy: null,
    isVoided: false,
    correctionReason: params.reason,
    status: 'synced',
    lastError: null,
    createdAt: new Date(corrected.loggedTimestamp).getTime(),
  })
}

let listenersRegistered = false

/** Registers the two retry triggers (reconnect, app foreground). Safe to call multiple times — only registers once. */
export function registerTruckTicketSyncListeners(): void {
  if (listenersRegistered) return
  listenersRegistered = true

  window.addEventListener('online', () => void syncQueuedTruckTickets())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncQueuedTruckTickets()
  })
}
