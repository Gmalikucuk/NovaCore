import { supabase } from './client'

export type PhotoCategory = 'daily_activity' | 'proof_of_work'

export interface PhotoAttachmentRow {
  id: string
  projectId: string
  workDate: string
  photoCategory: PhotoCategory
  lineItemTag: string | null
  station: number | null
  direction: string | null
  freeText: string | null
  storagePath: string
  capturedAt: string
}

const PHOTO_SELECT =
  'id, project_id, work_date, photo_category, line_item_tag, station, direction, free_text, storage_path, captured_at'

function mapPhotoRow(row: {
  id: string
  project_id: string
  work_date: string
  photo_category: string
  line_item_tag: string | null
  station: number | string | null
  direction: string | null
  free_text: string | null
  storage_path: string | null
  captured_at: string
}): PhotoAttachmentRow {
  return {
    id: row.id,
    projectId: row.project_id,
    workDate: row.work_date,
    photoCategory: row.photo_category as PhotoCategory,
    lineItemTag: row.line_item_tag,
    station: row.station === null ? null : Number(row.station),
    direction: row.direction,
    freeText: row.free_text,
    // Only ever read back rows this client itself inserted (already synced,
    // storage_path always set at insert time) — see insertPhotoAttachment.
    storagePath: row.storage_path ?? '',
    capturedAt: row.captured_at,
  }
}

/** Today's (or any work date's) photos for a project — used to repopulate the local queue table with server-confirmed rows on load, same pattern as fetchTodaysExtraAreaEvents. */
export async function fetchPhotosForProjectDate(projectId: string, workDate: string): Promise<PhotoAttachmentRow[]> {
  const { data, error } = await supabase
    .from('photo_attachments')
    .select(PHOTO_SELECT)
    .eq('project_id', projectId)
    .eq('work_date', workDate)
    .order('captured_at', { ascending: true })
  if (error) throw error
  return (data ?? []).map(mapPhotoRow)
}

/** Uploads an already-compressed JPEG blob to the private `photos` bucket at the given path. */
export async function uploadPhotoBlob(path: string, blob: Blob): Promise<void> {
  const { error } = await supabase.storage.from('photos').upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: false,
  })
  if (error) throw error
}

/**
 * Signed URLs for viewing photos already in the private `photos` bucket —
 * used for rows imported from a previous session, where no local blob
 * exists to build an object URL from. Batched into one request rather than
 * one createSignedUrl call per row.
 */
export async function createSignedPhotoUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {}
  const { data, error } = await supabase.storage.from('photos').createSignedUrls(paths, 3600)
  if (error) throw error
  const result: Record<string, string> = {}
  for (const item of data) {
    if (item.signedUrl && item.path) result[item.path] = item.signedUrl
  }
  return result
}

/**
 * Inserts the metadata row only after the blob has already landed in
 * Storage — photo_attachments has no client-reachable UPDATE (see the
 * migration comment), so unlike width_readings/extra_area there's no
 * "insert now as queued, flip to synced later" step; the row is written
 * once, fully-formed, exactly like this table's Storage-upload counterpart.
 * captured_by is omitted — server-derived via the same
 * effective_crew_member_id() trigger every other attribution column here
 * uses.
 */
export async function insertPhotoAttachment(params: {
  projectId: string
  workDate: string
  photoCategory: PhotoCategory
  lineItemTag: string | null
  station: number | null
  direction: string | null
  freeText: string | null
  storagePath: string
}): Promise<PhotoAttachmentRow> {
  const { data, error } = await supabase
    .from('photo_attachments')
    .insert({
      project_id: params.projectId,
      work_date: params.workDate,
      photo_category: params.photoCategory,
      line_item_tag: params.lineItemTag,
      station: params.station,
      direction: params.direction,
      free_text: params.freeText,
      storage_path: params.storagePath,
      local_status: 'synced',
    })
    .select(PHOTO_SELECT)
    .single()
  if (error) throw error
  return mapPhotoRow(data)
}
