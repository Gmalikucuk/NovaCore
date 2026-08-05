import Dexie, { type EntityTable } from 'dexie'

/**
 * Local, offline-first store for quantity_records. Mirrors the server table
 * exactly, plus one local-only field: `pending`. Both server-confirmed rows
 * (imported on load) and locally-queued not-yet-synced entries live here
 * together — one local table is the entire source of truth for the entry
 * screen, so the UI never reconciles two separate lists. Same shape as the
 * archived build's widthReadingsQueue; reused deliberately, not reinvented.
 *
 * `id` IS the primary key here, not a separate auto-increment localId with
 * a nullable serverId filled in after sync — quantity_records.id is a
 * client-generated UUID decided at capture time (spec §3), so the local and
 * server id are the same value from the moment the row exists. There's
 * nothing to reconcile after sync beyond flipping `pending` to false.
 */
export interface QueuedQuantityRecord {
  id: string
  contractId: string
  itemId: string
  /** work_date, YYYY-MM-DD — entered by the user, never read from the device clock. */
  workDate: string
  location: string | null
  quantity: number
  note: string | null
  status: 'draft' | 'confirmed'
  /** id of the record this one corrects, if any. Never edit a synced row in place — a correction is a new row. */
  supersedes: string | null
  confirmedBy: string | null
  confirmedAt: string | null
  createdBy: string
  deviceId: string | null
  createdAt: string
  syncedAt: string | null
  stationFrom: number | null
  stationTo: number | null
  /** Bumped server-side on every real draft edit (0022). Read back before confirming — confirm_quantity_record() requires this to match the row's CURRENT version, atomically, or it refuses rather than silently confirming an edit nobody saw. */
  version: number
  /** Local-only: true until this row has been successfully pushed to (or confirmed already present on) the server. */
  pending: boolean
  lastError: string | null
}

const db = new Dexie('novacore_v1') as Dexie & {
  quantityRecords: EntityTable<QueuedQuantityRecord, 'id'>
}

// `pending` is deliberately not indexed — IndexedDB (and Dexie's
// IndexableType) doesn't support boolean as a key; syncQueuedQuantityRecords
// filters it in JS instead of `.where('pending')`.
//
// v1 had this store as `dailyEntries` with `projectId`/`entryDate` keys —
// same database name, different shape. A version bump (not a same-version
// edit) is required so Dexie actually creates the new store for anyone with
// an existing `novacore_v1` database in their browser; editing v1's
// `.stores()` in place would leave `quantityRecords` undefined for them
// (Dexie only re-runs the schema for versions higher than what's already on
// disk). No upgrade() to carry rows over — pre-launch, no real user data yet,
// and the field renames (project_id -> contract_id etc.) would need
// transforming regardless. A stale v1 database is simply superseded.
db.version(1).stores({
  dailyEntries: 'id, projectId, entryDate, status',
})
db.version(2).stores({
  dailyEntries: null,
  quantityRecords: 'id, contractId, workDate, status',
})

export { db }
