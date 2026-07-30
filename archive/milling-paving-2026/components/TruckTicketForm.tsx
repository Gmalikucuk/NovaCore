import { useEffect, useMemo, useState } from 'react'
import { db, type QueuedTruckTicket } from '../lib/db'
import { enqueueTruckTicket, importServerTruckTickets, registerTruckTicketSyncListeners } from '../lib/sync/truckTicketsSync'
import { useLiveQuery } from '../lib/sync/useLiveQuery'
import './TruckTicketForm.css'

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message
  }
  return fallback
}

interface TruckTicketFormProps {
  roadSegmentId: string
  direction: string
  date: string
  hasIdentity: boolean
}

/**
 * "+ Add Truck Ticket" — same understated-toggle/bottom-sheet shape as
 * ExtraAreaForm, applied to truck_tickets instead of surface_lifecycle_events.
 * Tied to whichever segment is currently ACTIVE in the paving session (the
 * segment established by the most recent width reading), not a per-truck
 * segment picker — trucks arrive to wherever the crew is currently paving,
 * mirroring how PavingEntryScreen itself already tracks "current segment."
 */
export function TruckTicketForm({ roadSegmentId, direction, date, hasIdentity }: TruckTicketFormProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [vehicleNumber, setVehicleNumber] = useState('')
  const [ticketNumber, setTicketNumber] = useState('')
  const [tonnageInput, setTonnageInput] = useState('')
  const [liftType, setLiftType] = useState<'top_lift' | 'level_course'>('top_lift')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [justAdded, setJustAdded] = useState(false)

  // Set once the soft flag has fired for the current form contents and the
  // user has explicitly confirmed — cleared on any field edit so a changed
  // ticket number always gets re-checked rather than riding a stale
  // confirmation through.
  const [lowerTicketConfirm, setLowerTicketConfirm] = useState<{ newNum: number; lastNum: number } | null>(null)

  useEffect(() => {
    registerTruckTicketSyncListeners()
  }, [])

  useEffect(() => {
    if (!roadSegmentId) return
    importServerTruckTickets(roadSegmentId, date).catch(() => {
      // Import failures aren't fatal — the local queue still reflects
      // whatever was already pulled in, and sync retries independently.
    })
  }, [roadSegmentId, date])

  const allEntries = useLiveQuery(
    () =>
      roadSegmentId
        ? db.truckTicketsQueue
            .where('roadSegmentId')
            .equals(roadSegmentId)
            .filter((t) => t.date === date)
            .toArray()
        : Promise.resolve([]),
    [roadSegmentId, date],
    [] as QueuedTruckTicket[],
  )

  const sortedEntries = useMemo(() => [...allEntries].sort((a, b) => b.createdAt - a.createdAt), [allEntries])
  const activeEntries = useMemo(() => sortedEntries.filter((t) => t.supersededBy === null), [sortedEntries])
  const totalTonnage = useMemo(
    () =>
      activeEntries
        .filter((t) => t.liftType === 'top_lift' && !t.isVoided)
        .reduce((sum, t) => sum + t.netTonnage, 0),
    [activeEntries],
  )

  function resetForm() {
    setVehicleNumber('')
    setTicketNumber('')
    setTonnageInput('')
    setLiftType('top_lift')
    setFormError(null)
    setLowerTicketConfirm(null)
  }

  function clearFlag() {
    if (lowerTicketConfirm) setLowerTicketConfirm(null)
  }

  async function submitTicket() {
    const tonnageValue = Number(tonnageInput)
    setFormError(null)
    setSubmitting(true)
    try {
      await enqueueTruckTicket({
        roadSegmentId,
        direction,
        date,
        vehicleNumber: vehicleNumber.trim(),
        ticketNumber: ticketNumber.trim(),
        netTonnage: tonnageValue,
        liftType,
      })
      resetForm()
      setIsOpen(false)
      setJustAdded(true)
      window.setTimeout(() => setJustAdded(false), 4000)
    } catch (err) {
      setFormError(extractErrorMessage(err, 'Failed to queue ticket.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (vehicleNumber.trim() === '') {
      setFormError('Enter a vehicle number.')
      return
    }
    if (ticketNumber.trim() === '') {
      setFormError('Enter a ticket number.')
      return
    }
    const tonnageValue = Number(tonnageInput)
    if (tonnageInput.trim() === '' || !Number.isFinite(tonnageValue)) {
      setFormError('Enter a valid tonnage.')
      return
    }

    // Ticket-sequence soft flag: compare against the last logged ticket in
    // this session (most recently created, most recent arrival). Numeric
    // comparison only — if either number doesn't parse, skip the check
    // entirely rather than guessing at a non-numeric ordering. Never
    // rejects — just surfaces a confirmation the crew can dismiss.
    if (!lowerTicketConfirm) {
      const lastTicket = activeEntries[0] ?? null
      if (lastTicket) {
        const newNum = Number(ticketNumber.trim())
        const lastNum = Number(lastTicket.ticketNumber.trim())
        if (Number.isFinite(newNum) && Number.isFinite(lastNum) && newNum < lastNum) {
          setFormError(null)
          setLowerTicketConfirm({ newNum, lastNum })
          return
        }
      }
    }

    await submitTicket()
  }

  return (
    <section className="truck-ticket-section">
      <button type="button" className="truck-ticket-toggle" onClick={() => setIsOpen(true)} disabled={!hasIdentity}>
        + Add Truck Ticket
      </button>

      {justAdded && <p className="truck-ticket-confirmation">Ticket added.</p>}

      {activeEntries.length > 0 && (
        <div className="truck-ticket-list">
          <div className="truck-ticket-list-header">
            <h2>Truck Tickets</h2>
            <span className="truck-ticket-total">{totalTonnage.toFixed(2)} t</span>
          </div>
          <ul>
            {sortedEntries.map((entry) => {
              const isSuperseded = entry.supersededBy !== null
              const struckThrough = isSuperseded || entry.isVoided
              return (
                <li key={entry.localId} className={struckThrough ? 'truck-ticket-entry-superseded' : 'truck-ticket-entry'}>
                  <div className="truck-ticket-entry-top">
                    <span className="truck-ticket-entry-vehicle">{entry.vehicleNumber}</span>
                    <span className="truck-ticket-entry-tonnage">{entry.netTonnage} t</span>
                  </div>
                  <div className="truck-ticket-entry-bottom">
                    <span>Ticket #{entry.ticketNumber}</span>
                    <span>{entry.liftType === 'top_lift' ? 'Top lift' : 'Level course'}</span>
                  </div>
                  <div className="truck-ticket-entry-badges">
                    {entry.isCorrection && <span className="truck-ticket-badge truck-ticket-badge-correction">corrected</span>}
                    {isSuperseded && <span className="truck-ticket-badge truck-ticket-badge-superseded">superseded</span>}
                    {entry.isVoided && <span className="truck-ticket-badge truck-ticket-badge-superseded">voided</span>}
                    {!struckThrough && (
                      <span
                        className={
                          'milling-sync-dot' + (entry.status === 'synced' ? ' milling-sync-dot-synced' : ' milling-sync-dot-pending')
                        }
                        role="status"
                        aria-label={entry.status === 'synced' ? 'Synced' : 'Queued, syncing'}
                        title={entry.status === 'synced' ? 'Synced' : 'Queued, syncing'}
                      />
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {isOpen && (
        <div
          className="truck-ticket-backdrop"
          onClick={() => {
            setIsOpen(false)
            setFormError(null)
            setLowerTicketConfirm(null)
          }}
        >
          <form className="truck-ticket-form" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>Add Truck Ticket</h2>

            <label className="truck-ticket-field">
              <span>Vehicle number</span>
              <input
                type="text"
                autoComplete="off"
                value={vehicleNumber}
                onChange={(e) => {
                  setVehicleNumber(e.target.value)
                  clearFlag()
                }}
                placeholder="e.g. 14"
              />
            </label>

            <label className="truck-ticket-field">
              <span>Ticket number</span>
              <input
                type="text"
                autoComplete="off"
                value={ticketNumber}
                onChange={(e) => {
                  setTicketNumber(e.target.value)
                  clearFlag()
                }}
                placeholder="e.g. 48213"
              />
            </label>

            <label className="truck-ticket-field">
              <span>Net tonnage</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={tonnageInput}
                onChange={(e) => {
                  setTonnageInput(e.target.value)
                  clearFlag()
                }}
                placeholder="0.00"
              />
            </label>

            <div className="truck-ticket-lift-row">
              <span>Lift</span>
              <div className="truck-ticket-lift-buttons">
                <button
                  type="button"
                  className={'truck-ticket-lift-button' + (liftType === 'top_lift' ? ' truck-ticket-lift-button-selected' : '')}
                  onClick={() => setLiftType('top_lift')}
                >
                  Top lift
                </button>
                <button
                  type="button"
                  className={'truck-ticket-lift-button' + (liftType === 'level_course' ? ' truck-ticket-lift-button-selected' : '')}
                  onClick={() => setLiftType('level_course')}
                >
                  Level course
                </button>
              </div>
            </div>

            {lowerTicketConfirm && (
              <div className="truck-ticket-soft-flag">
                <p>
                  Ticket #{lowerTicketConfirm.newNum} is lower than the last logged (#{lowerTicketConfirm.lastNum}) — possible
                  delayed truck, confirm this is correct.
                </p>
                <div className="truck-ticket-soft-flag-actions">
                  <button type="button" className="truck-ticket-cancel" onClick={() => setLowerTicketConfirm(null)}>
                    Go back
                  </button>
                  <button type="submit" className="truck-ticket-submit" disabled={submitting}>
                    {submitting ? 'Saving…' : 'Confirm, add anyway'}
                  </button>
                </div>
              </div>
            )}

            {formError && <p className="truck-ticket-error">{formError}</p>}

            {!lowerTicketConfirm && (
              <div className="truck-ticket-actions">
                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false)
                    setFormError(null)
                  }}
                  className="truck-ticket-cancel"
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button type="submit" className="truck-ticket-submit" disabled={submitting}>
                  {submitting ? 'Saving…' : 'Add'}
                </button>
              </div>
            )}
          </form>
        </div>
      )}
    </section>
  )
}
