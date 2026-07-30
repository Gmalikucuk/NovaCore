import { useEffect, useMemo, useState } from 'react'
import { db } from '../lib/db'
import { LIFECYCLE_EVENT_TYPES } from '../lib/supabase/reviewQueue'
import {
  enqueueExtraAreaEvent,
  importServerExtraAreaEvents,
  registerExtraAreaSyncListeners,
  type QueuedExtraAreaEntry,
} from '../lib/sync/extraAreaSync'
import { useLiveQuery } from '../lib/sync/useLiveQuery'
import './ExtraAreaForm.css'

const DEFAULT_EVENT_TYPE = 'milled_tie_in'

// Supabase/PostgREST errors are plain objects with a `message` property, not
// actual Error instances — instanceof Error misses them, same pattern used
// everywhere else in this app for surfacing the real error.
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message
  }
  return fallback
}

function formatEventType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

interface ExtraAreaFormProps {
  roadSegmentId: string
  /** event_date, in YYYY-MM-DD form — same "today" the host screen's main entries use. */
  date: string
  hasIdentity: boolean
  /** Used as the from_station/to_station fallback when the field entry doesn't give a station. */
  segmentFromStation: number
  segmentToStation: number
}

/**
 * "+ Add extra area" — tie-ins, driveways, and other areas within contract
 * scope but outside the main continuous reading walk. Writes to
 * surface_lifecycle_events with entry_method='manual_area_entry' via the
 * same offline Dexie queue pattern as every other entry on these screens.
 *
 * Deliberately host-agnostic (no milling/paving assumptions): it only needs
 * a road_segment_id, a date, and the segment's station bounds. A future
 * PavingEntryScreen can mount this exact component unchanged and layer its
 * own linked_mill_event_id picker on top, rather than this component
 * growing a paving-specific prop.
 */
export function ExtraAreaForm({
  roadSegmentId,
  date,
  hasIdentity,
  segmentFromStation,
  segmentToStation,
}: ExtraAreaFormProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [eventType, setEventType] = useState(DEFAULT_EVENT_TYPE)
  const [quantityInput, setQuantityInput] = useState('')
  const [locationDescription, setLocationDescription] = useState('')
  const [stationInput, setStationInput] = useState('')
  const [fieldNarrative, setFieldNarrative] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [justAdded, setJustAdded] = useState(false)

  useEffect(() => {
    registerExtraAreaSyncListeners()
  }, [])

  useEffect(() => {
    if (!roadSegmentId) return
    importServerExtraAreaEvents(roadSegmentId, date).catch(() => {
      // Import failures aren't fatal here — the local queue still reflects
      // whatever was already pulled in, and sync retries independently.
    })
  }, [roadSegmentId, date])

  const allEntries = useLiveQuery(
    () =>
      roadSegmentId
        ? db.extraAreaQueue
            .where('roadSegmentId')
            .equals(roadSegmentId)
            .filter((r) => r.date === date)
            .toArray()
        : Promise.resolve([]),
    [roadSegmentId, date],
    [] as QueuedExtraAreaEntry[],
  )

  const sortedEntries = useMemo(
    () => [...allEntries].sort((a, b) => b.createdAt - a.createdAt),
    [allEntries],
  )

  function resetForm() {
    setEventType(DEFAULT_EVENT_TYPE)
    setQuantityInput('')
    setLocationDescription('')
    setStationInput('')
    setFieldNarrative('')
    setFormError(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const quantityValue = Number(quantityInput)
    if (quantityInput.trim() === '' || !Number.isFinite(quantityValue)) {
      setFormError('Enter a valid quantity.')
      return
    }
    if (locationDescription.trim() === '') {
      setFormError('Location description is required.')
      return
    }
    let stationValue: number | null = null
    if (stationInput.trim() !== '') {
      stationValue = Number(stationInput)
      if (!Number.isFinite(stationValue)) {
        setFormError('Enter a valid station, or leave it blank.')
        return
      }
    }

    setFormError(null)
    setSubmitting(true)
    try {
      await enqueueExtraAreaEvent({
        roadSegmentId,
        date,
        eventType,
        quantity: quantityValue,
        locationDescription: locationDescription.trim(),
        station: stationValue,
        fieldNarrative: fieldNarrative.trim() === '' ? null : fieldNarrative.trim(),
        segmentFromStation,
        segmentToStation,
      })
      resetForm()
      setIsOpen(false)
      setJustAdded(true)
      window.setTimeout(() => setJustAdded(false), 4000)
    } catch (err) {
      setFormError(extractErrorMessage(err, 'Failed to queue entry.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="extra-area-section">
      <button
        type="button"
        className="extra-area-toggle"
        onClick={() => setIsOpen(true)}
        disabled={!hasIdentity}
      >
        + Add extra area
      </button>

      {justAdded && <p className="extra-area-confirmation">Added — awaiting review.</p>}

      {sortedEntries.length > 0 && (
        <div className="extra-area-list">
          <h2>Extra Area Entries</h2>
          <ul>
            {sortedEntries.map((entry) => (
              <li key={entry.localId} className="extra-area-entry">
                <div className="extra-area-entry-top">
                  <span className="extra-area-entry-type">{formatEventType(entry.eventType)}</span>
                  <span className="extra-area-entry-qty">{entry.quantity} m²</span>
                </div>
                <div className="extra-area-entry-location">{entry.locationDescription}</div>
                {entry.station !== null && (
                  <div className="extra-area-entry-station">~station {entry.station}</div>
                )}
                <div className="extra-area-entry-badges">
                  {entry.status === 'queued' && (
                    <span className="extra-area-badge extra-area-badge-queued">Queued</span>
                  )}
                  {entry.status === 'synced' && entry.reviewStatus === 'pending_review' && (
                    <span className="extra-area-badge extra-area-badge-pending">Pending review</span>
                  )}
                  {entry.status === 'synced' && entry.reviewStatus === 'confirmed' && (
                    <span className="extra-area-badge extra-area-badge-confirmed">Confirmed</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isOpen && (
        <div
          className="extra-area-backdrop"
          onClick={() => {
            setIsOpen(false)
            setFormError(null)
          }}
        >
          <form className="extra-area-form" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>Add Extra Area</h2>
            <p className="extra-area-form-hint">
              For tie-ins, driveways, and other areas outside the main reading walk. A PM reviews
              this before it counts toward totals.
            </p>

            <label className="extra-area-field">
              <span>Type</span>
              <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
                {LIFECYCLE_EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {formatEventType(t)}
                  </option>
                ))}
              </select>
            </label>

            <label className="extra-area-field">
              <span>Quantity (m²)</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={quantityInput}
                onChange={(e) => setQuantityInput(e.target.value)}
                placeholder="0.00"
              />
            </label>

            <label className="extra-area-field">
              <span>Location description</span>
              <input
                type="text"
                autoComplete="off"
                value={locationDescription}
                onChange={(e) => setLocationDescription(e.target.value)}
                placeholder="e.g. Campbell Hill Driveway intersection"
              />
            </label>

            <label className="extra-area-field">
              <span>Station (optional)</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={stationInput}
                onChange={(e) => setStationInput(e.target.value)}
                placeholder="If known"
              />
            </label>

            <label className="extra-area-field">
              <span>Notes for PM (optional)</span>
              <textarea
                value={fieldNarrative}
                onChange={(e) => setFieldNarrative(e.target.value)}
                rows={3}
                placeholder="Anything the PM should know, e.g. if you're not sure how this should be classified"
              />
            </label>

            {formError && <p className="extra-area-error">{formError}</p>}

            <div className="extra-area-actions">
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false)
                  setFormError(null)
                }}
                className="extra-area-cancel"
                disabled={submitting}
              >
                Cancel
              </button>
              <button type="submit" className="extra-area-submit" disabled={submitting}>
                {submitting ? 'Saving…' : 'Add'}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}
