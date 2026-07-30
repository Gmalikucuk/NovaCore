import { useState } from 'react'
import { ModalSheet } from '../../components/ModalSheet'
import type { QueuedTruckTicket } from '../../lib/db'
import { applyTruckTicketCorrection } from '../../lib/sync/truckTicketsSync'

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message
  }
  return fallback
}

/** Direct mirror of CorrectionForm — same supersede-workflow shape, applied to truck_tickets' fields instead of station/width. */
export function TruckTicketCorrectionForm({
  entry,
  onClose,
  onSaved,
  isPastDayCorrection = false,
}: {
  entry: QueuedTruckTicket
  onClose: () => void
  onSaved?: () => void
  isPastDayCorrection?: boolean
}) {
  const [correctedVehicleNumber, setCorrectedVehicleNumber] = useState(entry.vehicleNumber)
  const [correctedTicketNumber, setCorrectedTicketNumber] = useState(entry.ticketNumber)
  const [correctedTonnage, setCorrectedTonnage] = useState(String(entry.netTonnage))
  const [correctedLiftType, setCorrectedLiftType] = useState<'top_lift' | 'level_course'>(entry.liftType)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (correctedVehicleNumber.trim() === '') {
      setError('Enter a vehicle number.')
      return
    }
    if (correctedTicketNumber.trim() === '') {
      setError('Enter a ticket number.')
      return
    }
    const tonnageValue = Number(correctedTonnage)
    if (!Number.isFinite(tonnageValue)) {
      setError('Enter a valid tonnage.')
      return
    }
    if (reason.trim() === '') {
      setError('Enter a correction reason.')
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      await applyTruckTicketCorrection({
        original: entry,
        correctedVehicleNumber: correctedVehicleNumber.trim(),
        correctedTicketNumber: correctedTicketNumber.trim(),
        correctedNetTonnage: tonnageValue,
        correctedLiftType,
        reason: reason.trim(),
      })
      onSaved?.()
      onClose()
    } catch (err) {
      setError(extractErrorMessage(err, 'Failed to save correction.'))
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
            {submitting ? 'Saving…' : 'Save Correction'}
          </button>
        </>
      }
    >
      <h2>Correct Truck Ticket</h2>
      <p className="milling-correction-original">
        Original: {entry.vehicleNumber} · Ticket #{entry.ticketNumber} · {entry.netTonnage} t
      </p>

      <label className="milling-field milling-field-large">
        <span>Vehicle number</span>
        <input type="text" autoComplete="off" value={correctedVehicleNumber} onChange={(e) => setCorrectedVehicleNumber(e.target.value)} />
      </label>

      <label className="milling-field milling-field-large">
        <span>Ticket number</span>
        <input type="text" autoComplete="off" value={correctedTicketNumber} onChange={(e) => setCorrectedTicketNumber(e.target.value)} />
      </label>

      <label className="milling-field milling-field-large">
        <span>Net tonnage</span>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={correctedTonnage}
          onChange={(e) => setCorrectedTonnage(e.target.value)}
        />
      </label>

      <label className="milling-field">
        <span>Lift</span>
        <select value={correctedLiftType} onChange={(e) => setCorrectedLiftType(e.target.value as 'top_lift' | 'level_course')}>
          <option value="top_lift">Top lift</option>
          <option value="level_course">Level course</option>
        </select>
      </label>

      <label className="milling-field">
        <span>Reason (required)</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Why is this being corrected?" />
      </label>

      {isPastDayCorrection && (
        <p className="milling-correction-past-day-warning">This may affect previously calculated totals.</p>
      )}

      {error && <p className="milling-error">{error}</p>}
    </ModalSheet>
  )
}
