import { useCallback, useEffect, useState } from 'react'
import { ProfileSelector } from '../../components/ProfileSelector'
import {
  LIFECYCLE_EVENT_TYPES,
  confirmReviewEvent,
  fetchPendingReviewEvents,
  type PendingReviewEvent,
} from '../../lib/supabase/reviewQueue'
import './ReviewQueueScreen.css'

// Supabase/PostgREST errors are plain objects with a `message` property, not
// actual Error instances — `instanceof Error` misses them and would hide the
// real reason behind a generic fallback string.
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message
  }
  return fallback
}

interface EditState {
  eventType: string
  quantity: string
  fromStation: string
  toStation: string
}

/**
 * Desktop-oriented (PM at a desk, not a field crew on a phone) review queue
 * for lifecycle events entered via entry_method='manual_area_entry' — tie-ins,
 * driveways, and other extra areas outside the main station-reading walk.
 * Only confirming here (role-gated to coordinators at the database level,
 * not just in this UI) moves an entry into the pool that contract-item
 * totals/reporting should count.
 */
export function ReviewQueueScreen() {
  const [events, setEvents] = useState<PendingReviewEvent[]>([])
  const [edits, setEdits] = useState<Record<string, EditState>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)

  const loadEvents = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    fetchPendingReviewEvents()
      .then((rows) => {
        setEvents(rows)
        setEdits((prev) => {
          const next: Record<string, EditState> = {}
          for (const row of rows) {
            next[row.id] = prev[row.id] ?? {
              eventType: row.eventType,
              quantity: row.quantity === null ? '' : String(row.quantity),
              fromStation: String(row.fromStation),
              toStation: String(row.toStation),
            }
          }
          return next
        })
      })
      .catch((err) => setLoadError(extractErrorMessage(err, 'Failed to load review queue.')))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadEvents()
  }, [loadEvents])

  function updateEdit(id: string, field: keyof EditState, value: string) {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }))
  }

  async function handleConfirm(event: PendingReviewEvent) {
    const edit = edits[event.id]
    const quantityValue = edit.quantity.trim() === '' ? null : Number(edit.quantity)
    const fromStationValue = Number(edit.fromStation)
    const toStationValue = Number(edit.toStation)

    if (edit.quantity.trim() !== '' && !Number.isFinite(quantityValue)) {
      setConfirmError('Enter a valid quantity.')
      return
    }
    if (!Number.isFinite(fromStationValue) || !Number.isFinite(toStationValue)) {
      setConfirmError('Enter valid stations.')
      return
    }

    setConfirmError(null)
    setConfirmingId(event.id)
    try {
      await confirmReviewEvent({
        id: event.id,
        eventType: edit.eventType,
        quantity: quantityValue,
        fromStation: fromStationValue,
        toStation: toStationValue,
      })
      loadEvents()
    } catch (err) {
      setConfirmError(extractErrorMessage(err, 'Failed to confirm — you may need coordinator role.'))
    } finally {
      setConfirmingId(null)
    }
  }

  return (
    <div className="review-queue-screen">
      <ProfileSelector />

      <h1>Review Queue</h1>
      <p className="review-queue-subtitle">
        Extra-area entries awaiting confirmation. Only confirmed events count toward official
        contract-item totals.
      </p>

      {loading && <p>Loading…</p>}
      {loadError && <p className="review-queue-error">{loadError}</p>}
      {!loading && !loadError && events.length === 0 && <p>Nothing pending review.</p>}
      {confirmError && <p className="review-queue-error">{confirmError}</p>}

      {events.length > 0 && (
        <table className="review-queue-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Segment</th>
              <th>Date</th>
              <th>Narrative</th>
              <th>Event type</th>
              <th>Quantity</th>
              <th>From station</th>
              <th>To station</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => {
              const edit = edits[event.id]
              if (!edit) return null
              return (
                <tr key={event.id}>
                  <td>{event.contractNumber}</td>
                  <td>
                    {event.highway} {event.direction}
                  </td>
                  <td>{event.eventDate}</td>
                  <td className="review-queue-narrative-cell">
                    {event.locationDescription && (
                      <div className="review-queue-location">{event.locationDescription}</div>
                    )}
                    <div className="review-queue-narrative">{event.fieldNarrative}</div>
                  </td>
                  <td>
                    <select
                      value={edit.eventType}
                      onChange={(e) => updateEdit(event.id, 'eventType', e.target.value)}
                    >
                      {LIFECYCLE_EVENT_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={edit.quantity}
                      onChange={(e) => updateEdit(event.id, 'quantity', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={edit.fromStation}
                      onChange={(e) => updateEdit(event.id, 'fromStation', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={edit.toStation}
                      onChange={(e) => updateEdit(event.id, 'toStation', e.target.value)}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="review-queue-confirm"
                      onClick={() => handleConfirm(event)}
                      disabled={confirmingId === event.id}
                    >
                      {confirmingId === event.id ? 'Confirming…' : 'Confirm'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
