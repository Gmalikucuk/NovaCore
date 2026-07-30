import { useState } from 'react'
import { ModalSheet } from '../../components/ModalSheet'
import { insertTruckTicketBetween } from '../../lib/supabase/truckTickets'

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message
  }
  return fallback
}

/** Direct mirror of InsertReadingAfterForm, applied to truck_tickets via insert_truck_ticket_between. */
export function InsertTruckTicketAfterForm({
  afterTicketId,
  afterTicketNumber,
  onClose,
  onSaved,
  isPastDayInsert = false,
}: {
  afterTicketId: string
  afterTicketNumber: string
  onClose: () => void
  onSaved?: () => void
  isPastDayInsert?: boolean
}) {
  const [vehicleNumber, setVehicleNumber] = useState('')
  const [ticketNumber, setTicketNumber] = useState('')
  const [tonnage, setTonnage] = useState('')
  const [liftType, setLiftType] = useState<'top_lift' | 'level_course'>('top_lift')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (vehicleNumber.trim() === '') {
      setError('Enter a vehicle number.')
      return
    }
    if (ticketNumber.trim() === '') {
      setError('Enter a ticket number.')
      return
    }
    const tonnageValue = Number(tonnage)
    if (tonnage.trim() === '' || !Number.isFinite(tonnageValue)) {
      setError('Enter a valid tonnage.')
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      await insertTruckTicketBetween(afterTicketId, vehicleNumber.trim(), ticketNumber.trim(), tonnageValue, liftType)
      onSaved?.()
      onClose()
    } catch (err) {
      // insert_truck_ticket_between raises a specific "No room left..."
      // message at numeric(10,3) precision limits, same as its width_readings
      // counterpart — surfaced as-is rather than a generic failure.
      setError(extractErrorMessage(err, 'Failed to insert this ticket.'))
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
            {submitting ? 'Adding…' : 'Add Ticket'}
          </button>
        </>
      }
    >
      <h2>Insert Ticket After</h2>
      <p className="milling-correction-original">After ticket #{afterTicketNumber}</p>

      <label className="milling-field milling-field-large">
        <span>Vehicle number</span>
        <input type="text" autoComplete="off" value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} />
      </label>

      <label className="milling-field milling-field-large">
        <span>Ticket number</span>
        <input type="text" autoComplete="off" value={ticketNumber} onChange={(e) => setTicketNumber(e.target.value)} />
      </label>

      <label className="milling-field milling-field-large">
        <span>Net tonnage</span>
        <input type="text" inputMode="decimal" autoComplete="off" value={tonnage} onChange={(e) => setTonnage(e.target.value)} placeholder="0.00" />
      </label>

      <label className="milling-field">
        <span>Lift</span>
        <select value={liftType} onChange={(e) => setLiftType(e.target.value as 'top_lift' | 'level_course')}>
          <option value="top_lift">Top lift</option>
          <option value="level_course">Level course</option>
        </select>
      </label>

      {isPastDayInsert && <p className="milling-correction-past-day-warning">This may affect previously calculated totals.</p>}

      {error && <p className="milling-error">{error}</p>}
    </ModalSheet>
  )
}
