import { useState } from 'react'
import { ModalSheet } from '../../components/ModalSheet'
import { voidTruckTicket } from '../../lib/supabase/truckTickets'

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message
  }
  return fallback
}

// Same preset + custom-reason pattern as VoidReadingForm's VOID_REASON_PRESETS.
const VOID_REASON_PRESETS = [
  { id: 'duplicate', label: 'Duplicate entry' },
  { id: 'field-error', label: 'Entered in error' },
  { id: 'other', label: 'Other' },
] as const

type VoidReasonPresetId = (typeof VOID_REASON_PRESETS)[number]['id']

/** Direct mirror of VoidReadingForm, applied to truck_tickets. */
export function VoidTruckTicketForm({
  ticketId,
  vehicleNumber,
  ticketNumber,
  onClose,
  onSaved,
  isPastDayVoid = false,
}: {
  ticketId: string
  vehicleNumber: string
  ticketNumber: string
  onClose: () => void
  onSaved?: () => void
  isPastDayVoid?: boolean
}) {
  const [reasonPreset, setReasonPreset] = useState<VoidReasonPresetId | null>(null)
  const [customReason, setCustomReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reason =
    reasonPreset === 'other' ? customReason.trim() : (VOID_REASON_PRESETS.find((p) => p.id === reasonPreset)?.label ?? '')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (reason === '') {
      setError(reasonPreset === 'other' ? 'Enter a reason for voiding this ticket.' : 'Select a reason for voiding this ticket.')
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      await voidTruckTicket(ticketId, reason)
      onSaved?.()
      onClose()
    } catch (err) {
      setError(extractErrorMessage(err, 'Failed to void this ticket.'))
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
            {submitting ? 'Voiding…' : 'Void Ticket'}
          </button>
        </>
      }
    >
      <h2>Void Truck Ticket</h2>
      <p className="milling-correction-original">
        {vehicleNumber} · Ticket #{ticketNumber}
      </p>

      <label className="milling-field">
        <span>Reason (required)</span>
        <select
          value={reasonPreset ?? ''}
          onChange={(e) => setReasonPreset((e.target.value || null) as VoidReasonPresetId | null)}
        >
          <option value="">Select a reason…</option>
          {VOID_REASON_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>

      {reasonPreset === 'other' && (
        <label className="milling-field">
          <span>Describe the reason</span>
          <textarea
            value={customReason}
            onChange={(e) => setCustomReason(e.target.value)}
            rows={3}
            placeholder="Why is this being voided?"
          />
        </label>
      )}

      {isPastDayVoid && <p className="milling-correction-past-day-warning">This may affect previously calculated totals.</p>}

      {error && <p className="milling-error">{error}</p>}
    </ModalSheet>
  )
}
