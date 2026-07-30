import { useEffect, useMemo, useRef, useState } from 'react'
import { ModalSheet } from './ModalSheet'
import { db } from '../lib/db'
import { compressImage } from '../lib/photoCompression'
import {
  enqueuePhoto,
  importServerPhotos,
  registerPhotoSyncListeners,
  type QueuedPhoto,
} from '../lib/sync/photoSync'
import { createSignedPhotoUrls, type PhotoCategory } from '../lib/supabase/photos'
import { useLiveQuery } from '../lib/sync/useLiveQuery'
import './PhotoCaptureForm.css'

// Placeholder list — Mehmet to confirm/adjust. No DB check constraint on
// line_item_tag on purpose (see the schema migration comment): changing
// this list should never need a migration.
const LINE_ITEM_PRESETS = [
  'Milled tie-in',
  'Segment boundary tie-in',
  'Rest area tie-in',
  'Driveway/intersection',
  'Unexpected condition',
  'Other',
] as const

const DIRECTIONS = ['NB', 'SB', 'EB', 'WB'] as const

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message
  }
  return fallback
}

/** "Other" is a form choice, not a real label — proof_of_work rows show what was actually typed (or the chosen preset) instead. */
function photoLabel(p: QueuedPhoto): string {
  if (p.photoCategory === 'daily_activity') return 'Daily activity'
  const tag = p.freeText && p.freeText.trim() !== '' ? p.freeText : p.lineItemTag
  return tag ?? 'Proof of work'
}

interface PhotoCaptureFormProps {
  projectId: string
  /** work_date, in YYYY-MM-DD form — same work date the host screen's main entries use. */
  workDate: string
  hasIdentity: boolean
  /** Prefills proof-of-work's optional direction field with the session's already-selected direction. */
  sessionDirection: string
}

/**
 * "+ Add Photo" — daily activity / proof-of-work photos, offline-queued and
 * compressed client-side before upload, same pattern as ExtraAreaForm.
 * ticket_scan is never offered here — Milling doesn't produce ticket scans;
 * that capture path is Paving-specific and still deferred.
 *
 * Unlike ExtraAreaForm, sync isn't a two-phase "insert as queued, flip to
 * synced" — photo_attachments has no client-reachable UPDATE, so the queued
 * state (and the blob itself) lives only in Dexie until upload+insert
 * succeeds in one shot (see photoSync.ts).
 */
export function PhotoCaptureForm({ projectId, workDate, hasIdentity, sessionDirection }: PhotoCaptureFormProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [category, setCategory] = useState<PhotoCategory>('daily_activity')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [lineItem, setLineItem] = useState<(typeof LINE_ITEM_PRESETS)[number]>(LINE_ITEM_PRESETS[0])
  const [customLineItem, setCustomLineItem] = useState('')
  const [station, setStation] = useState('')
  const [direction, setDirection] = useState('')
  const [caption, setCaption] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [justAdded, setJustAdded] = useState(false)
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({})
  const [viewingPhoto, setViewingPhoto] = useState<QueuedPhoto | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Keyed by localId, not by blob content — a fresh Blob instance can come
  // back from Dexie on every live-query tick even when the underlying data
  // hasn't changed, so URL.createObjectURL can't be called inline in render
  // without leaking a new object URL each time.
  const localBlobUrlsRef = useRef<Map<number, string>>(new Map())

  useEffect(() => {
    registerPhotoSyncListeners()
  }, [])

  useEffect(() => {
    if (!projectId) return
    importServerPhotos(projectId, workDate).catch(() => {
      // Import failures aren't fatal here — same reasoning as ExtraAreaForm.
    })
  }, [projectId, workDate])

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const allPhotos = useLiveQuery(
    () =>
      projectId
        ? db.photosQueue.where('projectId').equals(projectId).filter((p) => p.workDate === workDate).toArray()
        : Promise.resolve([]),
    [projectId, workDate],
    [] as QueuedPhoto[],
  )

  const sortedPhotos = useMemo(() => [...allPhotos].sort((a, b) => b.createdAt - a.createdAt), [allPhotos])

  // Maintains one object URL per queued (not-yet-synced, or synced-this-
  // session) photo's local blob, revoking any that fall out of the list —
  // e.g. once Dexie's row for it is gone. Rows imported from a previous
  // session have only an empty placeholder blob and are skipped here; they
  // resolve to a signed URL instead (see the effect below).
  useEffect(() => {
    const cache = localBlobUrlsRef.current
    const currentIds = new Set(allPhotos.map((p) => p.localId).filter((id): id is number => id !== undefined))
    for (const [id, url] of cache) {
      if (!currentIds.has(id)) {
        URL.revokeObjectURL(url)
        cache.delete(id)
      }
    }
    for (const p of allPhotos) {
      if (p.blob.size > 0 && p.localId !== undefined && !cache.has(p.localId)) {
        cache.set(p.localId, URL.createObjectURL(p.blob))
      }
    }
  }, [allPhotos])

  useEffect(() => {
    const cache = localBlobUrlsRef.current
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url)
      cache.clear()
    }
  }, [])

  useEffect(() => {
    const needed = [
      ...new Set(
        allPhotos
          .filter((p) => p.blob.size === 0 && p.storagePath && !signedUrls[p.storagePath])
          .map((p) => p.storagePath as string),
      ),
    ]
    if (needed.length === 0) return
    createSignedPhotoUrls(needed)
      .then((urls) => setSignedUrls((prev) => ({ ...prev, ...urls })))
      .catch(() => {
        // Thumbnail fetch failures aren't fatal — the row still shows without one.
      })
  }, [allPhotos, signedUrls])

  function photoSrc(p: QueuedPhoto): string | null {
    if (p.localId !== undefined && localBlobUrlsRef.current.has(p.localId)) {
      return localBlobUrlsRef.current.get(p.localId)!
    }
    if (p.storagePath && signedUrls[p.storagePath]) return signedUrls[p.storagePath]
    return null
  }

  function resetForm() {
    setCategory('daily_activity')
    setFile(null)
    setPreviewUrl(null)
    setLineItem(LINE_ITEM_PRESETS[0])
    setCustomLineItem('')
    setStation('')
    setDirection(sessionDirection)
    setCaption('')
    setFormError(null)
  }

  function openForm() {
    resetForm()
    setIsOpen(true)
  }

  function handleFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!chosen) return
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(chosen)
    setPreviewUrl(URL.createObjectURL(chosen))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!file) {
      setFormError('Take a photo first.')
      return
    }

    let stationValue: number | null = null
    if (category === 'proof_of_work' && station.trim() !== '') {
      stationValue = Number(station)
      if (!Number.isFinite(stationValue)) {
        setFormError('Enter a valid station, or leave it blank.')
        return
      }
    }

    if (category === 'proof_of_work' && lineItem === 'Other' && customLineItem.trim() === '') {
      setFormError('Describe what this photo shows.')
      return
    }

    setFormError(null)
    setSubmitting(true)
    try {
      const blob = await compressImage(file)
      await enqueuePhoto({
        projectId,
        workDate,
        photoCategory: category,
        lineItemTag: category === 'proof_of_work' ? lineItem : null,
        station: stationValue,
        direction: category === 'proof_of_work' && direction !== '' ? direction : null,
        freeText:
          category === 'daily_activity'
            ? caption.trim() === ''
              ? null
              : caption.trim()
            : lineItem === 'Other'
              ? customLineItem.trim()
              : null,
        blob,
      })
      setIsOpen(false)
      setJustAdded(true)
      window.setTimeout(() => setJustAdded(false), 4000)
    } catch (err) {
      setFormError(extractErrorMessage(err, 'Failed to queue photo.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="photo-capture-section">
      <button type="button" className="photo-capture-toggle" onClick={openForm} disabled={!hasIdentity}>
        + Add Photo
      </button>

      {justAdded && <p className="photo-capture-confirmation">Added — syncing.</p>}

      {sortedPhotos.length > 0 && (
        <ul className="photo-capture-list">
          {sortedPhotos.map((p) => {
            const src = photoSrc(p)
            return (
              <li key={p.localId}>
                <button type="button" className="photo-capture-entry" onClick={() => src && setViewingPhoto(p)} disabled={!src}>
                  {src ? (
                    <img className="photo-capture-thumb" src={src} alt="" />
                  ) : (
                    <span className="photo-capture-thumb photo-capture-thumb-empty" aria-hidden="true" />
                  )}
                  <span className="photo-capture-entry-category">{photoLabel(p)}</span>
                  <span
                    className={'milling-sync-dot' + (p.status === 'synced' ? ' milling-sync-dot-synced' : ' milling-sync-dot-pending')}
                    role="status"
                    aria-label={p.status === 'synced' ? 'Synced' : 'Queued, syncing'}
                    title={p.status === 'synced' ? 'Synced' : 'Queued, syncing'}
                  />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {viewingPhoto && (
        <div className="photo-capture-viewer-backdrop" onClick={() => setViewingPhoto(null)}>
          <img className="photo-capture-viewer-image" src={photoSrc(viewingPhoto) ?? ''} alt="" />
        </div>
      )}

      {isOpen && (
        <ModalSheet
          onClose={() => setIsOpen(false)}
          onSubmit={handleSubmit}
          actions={
            <>
              <button type="button" onClick={() => setIsOpen(false)} className="milling-cancel" disabled={submitting}>
                Cancel
              </button>
              <button type="submit" className="milling-submit" disabled={submitting}>
                {submitting ? 'Saving…' : 'Add Photo'}
              </button>
            </>
          }
        >
          <h2>Add Photo</h2>

          <div className="photo-capture-category-choice">
            <button
              type="button"
              className={category === 'daily_activity' ? 'photo-capture-category-active' : ''}
              onClick={() => setCategory('daily_activity')}
            >
              Daily activity
            </button>
            <button
              type="button"
              className={category === 'proof_of_work' ? 'photo-capture-category-active' : ''}
              onClick={() => setCategory('proof_of_work')}
            >
              Proof of work
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="photo-capture-file-input"
            onChange={handleFileChosen}
          />

          {previewUrl ? (
            <div className="photo-capture-preview">
              <img src={previewUrl} alt="Captured preview" />
              <button type="button" className="photo-capture-retake" onClick={() => fileInputRef.current?.click()}>
                Retake
              </button>
            </div>
          ) : (
            <button type="button" className="photo-capture-take" onClick={() => fileInputRef.current?.click()}>
              📷 Take Photo
            </button>
          )}

          {category === 'daily_activity' && (
            <label className="milling-field">
              <span>Caption (optional)</span>
              <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} placeholder="What's this photo of?" />
            </label>
          )}

          {category === 'proof_of_work' && (
            <>
              <label className="milling-field">
                <span>What does this show?</span>
                <select value={lineItem} onChange={(e) => setLineItem(e.target.value as (typeof LINE_ITEM_PRESETS)[number])}>
                  {LINE_ITEM_PRESETS.map((preset) => (
                    <option key={preset} value={preset}>
                      {preset}
                    </option>
                  ))}
                </select>
              </label>

              {lineItem === 'Other' && (
                <label className="milling-field">
                  <span>Describe</span>
                  <textarea value={customLineItem} onChange={(e) => setCustomLineItem(e.target.value)} rows={2} placeholder="What does this photo show?" />
                </label>
              )}

              <label className="milling-field milling-field-large">
                <span>Station (optional)</span>
                <input type="text" inputMode="decimal" autoComplete="off" value={station} onChange={(e) => setStation(e.target.value)} />
              </label>

              <label className="milling-field">
                <span>Direction (optional)</span>
                <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                  <option value="">—</option>
                  {DIRECTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {formError && <p className="milling-error">{formError}</p>}
        </ModalSheet>
      )}
    </section>
  )
}
