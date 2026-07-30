import { useState } from 'react'
import { ModalSheet } from '../../components/ModalSheet'
import type { QueuedWidthReading } from '../../lib/db'
import { applyCorrection } from '../../lib/sync/widthReadingsSync'

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message
  }
  return fallback
}

// Built generically for reuse by the future Paving screen — pre-compaction
// readings needing remeasurement after compaction is a real, recurring
// paving scenario. Won't see real use on Milling yet; that's expected.
const REASON_PRESETS = [
  { id: 'post-compaction', label: 'Post-compaction remeasurement' },
  { id: 'field-error', label: 'Field measurement error' },
  { id: 'other', label: 'Other' },
] as const

type ReasonPresetId = (typeof REASON_PRESETS)[number]['id']

export function CorrectionForm({
  entry,
  onClose,
  onSaved,
  isPastDayCorrection = false,
}: {
  entry: QueuedWidthReading
  onClose: () => void
  /** Called after a successful save, in addition to onClose — lets a caller (e.g. the day-detail view) refresh its own data instead of assuming onClose alone means "done, nothing to refetch." */
  onSaved?: () => void
  /** True when correcting an entry from a past day via the read-only history view, not the current live session — that live view already shows the recalculated total immediately, so it doesn't need this warning. */
  isPastDayCorrection?: boolean
}) {
  const [correctedStation, setCorrectedStation] = useState(String(entry.station))
  const [correctedWidth, setCorrectedWidth] = useState(String(entry.width))
  const [reasonPreset, setReasonPreset] = useState<ReasonPresetId | null>(null)
  const [customReason, setCustomReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reason = reasonPreset === 'other' ? customReason.trim() : (REASON_PRESETS.find((p) => p.id === reasonPreset)?.label ?? '')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const stationValue = Number(correctedStation)
    const widthValue = Number(correctedWidth)
    if (!Number.isFinite(stationValue)) {
      setError('Enter a valid station.')
      return
    }
    if (!Number.isFinite(widthValue)) {
      setError('Enter a valid width.')
      return
    }
    if (reason === '') {
      setError(reasonPreset === 'other' ? 'Enter a correction reason.' : 'Select a correction reason.')
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      await applyCorrection({
        original: entry,
        correctedStation: stationValue,
        correctedWidth: widthValue,
        reason,
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
      <h2>Correct Entry</h2>
      <p className="milling-correction-original">
        Original: {entry.station} m, {entry.width} m wide
      </p>

      <label className="milling-field milling-field-large">
        <span>Corrected station (m)</span>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={correctedStation}
          onChange={(e) => setCorrectedStation(e.target.value)}
        />
      </label>

      <label className="milling-field milling-field-large">
        <span>Corrected width (m)</span>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={correctedWidth}
          onChange={(e) => setCorrectedWidth(e.target.value)}
        />
      </label>

      <label className="milling-field">
        <span>Reason (required)</span>
        <select
          value={reasonPreset ?? ''}
          onChange={(e) => setReasonPreset((e.target.value || null) as ReasonPresetId | null)}
        >
          <option value="">Select a reason…</option>
          {REASON_PRESETS.map((preset) => (
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
            placeholder="Why is this being corrected?"
          />
        </label>
      )}

      {isPastDayCorrection && (
        <p className="milling-correction-past-day-warning">This may affect previously calculated totals.</p>
      )}

      {error && <p className="milling-error">{error}</p>}
    </ModalSheet>
  )
}
