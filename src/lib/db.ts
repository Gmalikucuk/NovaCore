import Dexie, { type EntityTable } from 'dexie'

/**
 * Local, offline-first store for daily_entries. Mirrors the server table
 * exactly, plus one local-only field: `pending`. Both server-confirmed rows
 * (imported on load) and locally-queued not-yet-synced entries live here
 * together — one local table is the entire source of truth for the entry
 * screen, so the UI never reconciles two separate lists. Same shape as the
 * archived build's widthReadingsQueue; reused deliberately, not reinvented.
 *
 * `id` IS the primary key here, not a separate auto-increment localId with
 * a nullable serverId filled in after sync — daily_entries.id is a
 * client-generated UUID decided at capture time (spec §3), so the local and
 * server id are the same value from the moment the row exists. There's
 * nothing to reconcile after sync beyond flipping `pending` to false.
 */
export interface QueuedDailyEntry {
  id: string
  projectId: string
  lineItemId: string
  /** entry_date, YYYY-MM-DD — entered by the user, never read from the device clock. */
  entryDate: string
  location: string | null
  quantity: number
  note: string | null
  status: 'draft' | 'confirmed'
  /** id of the entry this one corrects, if any. Never edit a synced row in place — a correction is a new row. */
  supersedes: string | null
  confirmedBy: string | null
  confirmedAt: string | null
  createdBy: string
  deviceId: string | null
  createdAt: string
  syncedAt: string | null
  stationFrom: number | null
  stationTo: number | null
  /** Local-only: true until this row has been successfully pushed to (or confirmed already present on) the server. */
  pending: boolean
  lastError: string | null
}

const db = new Dexie('novacore_v1') as Dexie & {
  dailyEntries: EntityTable<QueuedDailyEntry, 'id'>
}

// `pending` is deliberately not indexed — IndexedDB (and Dexie's
// IndexableType) doesn't support boolean as a key; syncQueuedEntries filters
// it in JS instead of `.where('pending')`.
db.version(1).stores({
  dailyEntries: 'id, projectId, entryDate, status',
})

export { db }
