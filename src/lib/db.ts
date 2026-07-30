import Dexie, { type EntityTable } from 'dexie'

/**
 * Local, offline-first store for width_readings — shared by both Milling
 * and Paving's entry screens (same table, same queue shape, distinguished
 * by `activity`), not a Milling-only store despite the name. Both server-
 * confirmed rows (imported on load) and locally-queued not-yet-synced
 * entries live here together, so the UI never has to reconcile two
 * separate lists.
 */
export interface QueuedWidthReading {
  localId?: number
  /** width_readings.id once synced to Supabase; null while only queued locally. */
  serverId: string | null
  activity: 'milling' | 'paving'
  roadSegmentId: string
  direction: string
  /** paving_date, in YYYY-MM-DD form. */
  date: string
  stationSequence: number
  station: number
  width: number
  isCorrection: boolean
  /** serverId of the row that superseded this one, once known. */
  supersededBy: string | null
  isVoided: boolean
  correctionReason: string | null
  status: 'queued' | 'synced' | 'error'
  lastError: string | null
  createdAt: number
}

/**
 * Local, offline-first store for "extra area" surface_lifecycle_events
 * (entry_method='manual_area_entry') — tie-ins, driveways, and other areas
 * outside the main continuous station/width walk. Same "one local table is
 * the whole source of truth" pattern as widthReadingsQueue above: both
 * server-imported and locally-queued-not-yet-synced rows live here
 * together.
 */
export interface QueuedExtraAreaEntry {
  localId?: number
  /** surface_lifecycle_events.id once synced; null while only queued locally. */
  serverId: string | null
  roadSegmentId: string
  /** event_date, in YYYY-MM-DD form. */
  date: string
  eventType: string
  quantity: number
  locationDescription: string
  /** Field-entered station, if given — display only; may differ from fromStation/toStation once a coordinator refines the range on review. */
  station: number | null
  /** Always set (from_station/to_station are NOT NULL) — station if given, else the segment's own bounds as a rough placeholder a coordinator narrows down during review. */
  fromStation: number
  toStation: number
  fieldNarrative: string | null
  /** null until this entry has synced and its server-side review_status is known. */
  reviewStatus: 'pending_review' | 'confirmed' | null
  status: 'queued' | 'synced' | 'error'
  lastError: string | null
  createdAt: number
}

/**
 * Local, offline-first store for photo_attachments (daily_activity /
 * proof_of_work only — ticket_scan capture is Paving-specific and doesn't
 * exist yet). Unlike widthReadingsQueue/extraAreaQueue, the blob itself
 * lives here too: a queued photo has nothing server-side to import back
 * until it fully syncs (photo_attachments has no client-reachable UPDATE,
 * so there's no "insert now, flip status later" row to mirror — see
 * photoSync.ts), so the compressed image data has to survive a page reload
 * on its own.
 */
export interface QueuedPhoto {
  localId?: number
  /** photo_attachments.id once synced; null while only queued locally. */
  serverId: string | null
  projectId: string
  /** work_date, in YYYY-MM-DD form. */
  workDate: string
  photoCategory: 'daily_activity' | 'proof_of_work'
  lineItemTag: string | null
  station: number | null
  direction: string | null
  freeText: string | null
  blob: Blob
  /** Set once this photo has actually uploaded to Storage — null while only queued locally. Lets the list resolve a viewable image (via a signed URL) for rows imported from a previous session, where the local blob is just an empty placeholder. */
  storagePath: string | null
  status: 'queued' | 'synced' | 'error'
  lastError: string | null
  createdAt: number
}

/**
 * Local, offline-first store for truck_tickets (Paving only — Milling never
 * produces these). Same "one local table is the whole source of truth"
 * shape as widthReadingsQueue, mirrored deliberately rather than
 * reinvented — see truckTicketsSync.ts.
 */
export interface QueuedTruckTicket {
  localId?: number
  /** truck_tickets.id once synced to Supabase; null while only queued locally. */
  serverId: string | null
  roadSegmentId: string
  direction: string
  /** paving_date, in YYYY-MM-DD form. */
  date: string
  arrivalSequence: number
  vehicleNumber: string
  ticketNumber: string
  netTonnage: number
  liftType: 'top_lift' | 'level_course'
  isCorrection: boolean
  /** serverId of the row that superseded this one, once known. */
  supersededBy: string | null
  isVoided: boolean
  correctionReason: string | null
  status: 'queued' | 'synced' | 'error'
  lastError: string | null
  createdAt: number
}

const db = new Dexie('novacore') as Dexie & {
  widthReadingsQueue: EntityTable<QueuedWidthReading, 'localId'>
  extraAreaQueue: EntityTable<QueuedExtraAreaEntry, 'localId'>
  photosQueue: EntityTable<QueuedPhoto, 'localId'>
  truckTicketsQueue: EntityTable<QueuedTruckTicket, 'localId'>
}

db.version(1).stores({
  widthReadingsQueue: '++localId, serverId, roadSegmentId, date, status',
})

db.version(2).stores({
  widthReadingsQueue: '++localId, serverId, roadSegmentId, date, status',
  extraAreaQueue: '++localId, serverId, roadSegmentId, date, status',
})

db.version(3).stores({
  widthReadingsQueue: '++localId, serverId, roadSegmentId, date, status',
  extraAreaQueue: '++localId, serverId, roadSegmentId, date, status',
  photosQueue: '++localId, serverId, projectId, workDate, status',
})

db.version(4).stores({
  widthReadingsQueue: '++localId, serverId, activity, roadSegmentId, date, status',
  extraAreaQueue: '++localId, serverId, roadSegmentId, date, status',
  photosQueue: '++localId, serverId, projectId, workDate, status',
})

db.version(5).stores({
  widthReadingsQueue: '++localId, serverId, activity, roadSegmentId, date, status',
  extraAreaQueue: '++localId, serverId, roadSegmentId, date, status',
  photosQueue: '++localId, serverId, projectId, workDate, status',
  truckTicketsQueue: '++localId, serverId, roadSegmentId, date, status',
})

export { db }
