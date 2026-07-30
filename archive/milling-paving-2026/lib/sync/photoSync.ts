import { db, type QueuedPhoto } from '../db'
import { fetchPhotosForProjectDate, insertPhotoAttachment, uploadPhotoBlob, type PhotoCategory } from '../supabase/photos'

/**
 * Same offline-queue shape as extraAreaSync.ts, with one structural
 * difference: photo_attachments has no client-reachable UPDATE (see the
 * migration comment on photos.ts's insertPhotoAttachment), so a queued
 * photo has no partial server row to flip to 'synced' — sync is a single
 * upload-then-insert step, and the row only ever gets written once, fully
 * formed, on success.
 */

/** Pulls this project/date's server-confirmed photos into the local queue table (as 'synced'), so the running list always reads from one local source. */
export async function importServerPhotos(projectId: string, workDate: string): Promise<void> {
  const serverRows = await fetchPhotosForProjectDate(projectId, workDate)
  for (const row of serverRows) {
    const existing = await db.photosQueue.where('serverId').equals(row.id).first()
    if (existing) continue
    // The blob itself was never fetched back from Storage — an empty
    // placeholder stands in for it, and the list resolves a viewable image
    // for these rows via a signed URL built from storagePath instead (see
    // PhotoCaptureForm's thumbnail/full-view logic).
    await db.photosQueue.add({
      serverId: row.id,
      projectId: row.projectId,
      workDate: row.workDate,
      photoCategory: row.photoCategory,
      lineItemTag: row.lineItemTag,
      station: row.station,
      direction: row.direction,
      freeText: row.freeText,
      blob: new Blob(),
      storagePath: row.storagePath,
      status: 'synced',
      lastError: null,
      createdAt: new Date(row.capturedAt).getTime(),
    })
  }
}

/** Queues a brand-new photo immediately (optimistic UI, blob kept locally for retry), then attempts to sync it right away. */
export async function enqueuePhoto(entry: {
  projectId: string
  workDate: string
  photoCategory: PhotoCategory
  lineItemTag: string | null
  station: number | null
  direction: string | null
  freeText: string | null
  blob: Blob
}): Promise<void> {
  await db.photosQueue.add({
    serverId: null,
    projectId: entry.projectId,
    workDate: entry.workDate,
    photoCategory: entry.photoCategory,
    lineItemTag: entry.lineItemTag,
    station: entry.station,
    direction: entry.direction,
    freeText: entry.freeText,
    blob: entry.blob,
    storagePath: null,
    status: 'queued',
    lastError: null,
    createdAt: Date.now(),
  })

  void syncQueuedPhotos()
}

function storagePathFor(item: QueuedPhoto): string {
  return `${item.projectId}/${item.workDate}/${item.photoCategory}/${crypto.randomUUID()}.jpg`
}

/** Attempts to upload+insert every currently-queued photo. Safe to call repeatedly — entries already synced are skipped. */
export async function syncQueuedPhotos(): Promise<void> {
  const pending = await db.photosQueue.where('status').equals('queued').sortBy('createdAt')

  for (const item of pending) {
    try {
      const path = storagePathFor(item)
      await uploadPhotoBlob(path, item.blob)
      const inserted = await insertPhotoAttachment({
        projectId: item.projectId,
        workDate: item.workDate,
        photoCategory: item.photoCategory,
        lineItemTag: item.lineItemTag,
        station: item.station,
        direction: item.direction,
        freeText: item.freeText,
        storagePath: path,
      })
      await db.photosQueue.update(item.localId!, {
        status: 'synced',
        serverId: inserted.id,
        storagePath: path,
        lastError: null,
      })
    } catch (err) {
      // Left as 'queued', same reasoning as widthReadingsSync/extraAreaSync
      // — a network drop is expected and recoverable, not a permanent
      // failure. Retrying re-uploads the blob under a fresh random path
      // (upsert: false), so a partial prior attempt never collides.
      await db.photosQueue.update(item.localId!, {
        lastError: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

let listenersRegistered = false

/** Registers the two retry triggers (reconnect, app foreground). Safe to call multiple times — only registers once. */
export function registerPhotoSyncListeners(): void {
  if (listenersRegistered) return
  listenersRegistered = true

  window.addEventListener('online', () => void syncQueuedPhotos())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncQueuedPhotos()
  })
}

export type { QueuedPhoto }
