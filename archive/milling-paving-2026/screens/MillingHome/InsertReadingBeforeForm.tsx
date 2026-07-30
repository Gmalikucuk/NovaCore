import { useState } from 'react'
import { ModalSheet } from '../../components/ModalSheet'
import { insertWidthReadingBefore } from '../../lib/supabase/milling'

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message
  }
  return fallback
}

/** Mirror of InsertReadingAfterForm — same shape, calling insertWidthReadingBefore instead. */
export function InsertReadingBeforeForm({
  beforeReadingId,
  beforeStation,
  onClose,
  onSaved,
  isPastDayInsert = false,
}: {
  beforeReadingId: string
  beforeStation: number
  onClose: () => void
  onSaved?: () => void
  /** True when inserting into a past day's session via the read-only review screen, not the current live session. */
  isPastDayInsert?: boolean
}) {
  const [station, setStation] = useState('')
  const [width, setWidth] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const stationValue = Number(station)
    const widthValue = Number(width)
    if (station.trim() === '' || !Number.isFinite(stationValue)) {
      setError('Enter a valid station.')
      return
    }
    if (width.trim() === '' || !Number.isFinite(widthValue)) {
      setError('Enter a valid width.')
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      await insertWidthReadingBefore(beforeReadingId, stationValue, widthValue)
      onSaved?.()
      onClose()
    } catch (err) {
      // insert_width_reading_before raises the same "No room left..."
      // message insert_width_reading_between does when the two neighboring
      // sequence values are already as close as the column's numeric(10,3)
      // precision allows — surfaces here as-is via extractErrorMessage
      // rather than a generic failure.
      setError(extractErrorMessage(err, 'Failed to insert this reading.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalSheet
      onClose={onClose}
      onSubmit={handleSubmit}
      actions={
        <>
          <button type="button" onClick={onClose} className="milling-cancel" disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="milling-submit" disabled={submitting}>
            {submitting ? 'Adding…' : 'Add Reading'}
          </button>
        </>
      }
    >
      <h2>Insert Reading Before</h2>
      <p className="milling-correction-original">Before {beforeStation} m</p>

      <label className="milling-field milling-field-large">
        <span>Station (m)</span>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={station}
          onChange={(e) => setStation(e.target.value)}
          placeholder="0.00"
        />
      </label>

      <label className="milling-field milling-field-large">
        <span>Width (m)</span>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={width}
          onChange={(e) => setWidth(e.target.value)}
          placeholder="0.00"
        />
      </label>

      {isPastDayInsert && <p className="milling-correction-past-day-warning">This may affect previously calculated totals.</p>}

      {error && <p className="milling-error">{error}</p>}
    </ModalSheet>
  )
}
