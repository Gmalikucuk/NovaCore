import { useState } from 'react'
import { ModalSheet } from '../../components/ModalSheet'
import { insertTruckTicketBefore } from '../../lib/supabase/truckTickets'

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message
  }
  return fallback
}

/** Mirror of InsertTruckTicketAfterForm — same shape, calling insertTruckTicketBefore instead. */
export function InsertTruckTicketBeforeForm({
  beforeTicketId,
  beforeTicketNumber,
  onClose,
  onSaved,
  isPastDayInsert = false,
}: {
  beforeTicketId: string
  beforeTicketNumber: string
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
      await insertTruckTicketBefore(beforeTicketId, vehicleNumber.trim(), ticketNumber.trim(), tonnageValue, liftType)
      onSaved?.()
      onClose()
    } catch (err) {
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
      <h2>Insert Ticket Before</h2>
      <p className="milling-correction-original">Before ticket #{beforeTicketNumber}</p>

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
