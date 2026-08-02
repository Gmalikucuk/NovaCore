import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { MyProject } from '../../lib/supabase/projects'
import { useSession } from '../../lib/useSession'
import { fetchLineItems, type LineItem } from '../../lib/supabase/lineItems'
import { confirmDailyEntry, fetchDistinctLocations, fetchEntriesForDate, pushDailyEntry } from '../../lib/supabase/entries'
import type { QueuedDailyEntry } from '../../lib/db'
import { getDeviceId } from '../../lib/deviceId'
import { errorMessage } from '../../lib/errorMessage'
import { todayLocalDateString } from '../../lib/dateFormat'
import './DailyEntryScreen.css'

type DayEntry = Omit<QueuedDailyEntry, 'pending' | 'lastError'>

const BLANK = { location: '', stationFrom: '', stationTo: '', quantity: '', note: '' }

export function DailyEntryScreen() {
  const project = useOutletContext<MyProject>()
  const isPm = project.role === 'project_manager'
  const session = useSession()
  const userId = session?.user.id ?? null

  const [entryDate, setEntryDate] = useState(todayLocalDateString())
  const [lineItems, setLineItems] = useState<LineItem[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [entries, setEntries] = useState<DayEntry[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [lineItemId, setLineItemId] = useState('')
  const [fields, setFields] = useState(BLANK)
  const [correctingId, setCorrectingId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const stationFromRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchLineItems(project.id)
      .then((items) => {
        setLineItems(items)
        setLineItemId((prev) => prev || items[0]?.id || '')
      })
      .catch((err: unknown) => setLoadError(errorMessage(err)))
    fetchDistinctLocations(project.id)
      .then(setLocations)
      .catch(() => {
        /* autocomplete only — not worth surfacing as a page error */
      })
  }, [project.id])

  function reload() {
    setStatus('loading')
    fetchEntriesForDate(project.id, entryDate)
      .then((rows) => {
        setEntries(rows)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }

  useEffect(reload, [project.id, entryDate])

  const lineItemById = useMemo(() => new Map(lineItems.map((li) => [li.id, li])), [lineItems])

  const supersededByConfirmed = useMemo(() => {
    const set = new Set<string>()
    for (const e of entries) {
      if (e.supersedes && e.status === 'confirmed') set.add(e.supersedes)
    }
    return set
  }, [entries])

  const reachMetres = useMemo(() => {
    const from = Number(fields.stationFrom)
    const to = Number(fields.stationTo)
    if (fields.stationFrom === '' || fields.stationTo === '' || Number.isNaN(from) || Number.isNaN(to)) return null
    return to - from
  }, [fields.stationFrom, fields.stationTo])

  function resetForm() {
    setFields(BLANK)
    setCorrectingId(null)
  }

  function startCorrection(entry: DayEntry) {
    setCorrectingId(entry.id)
    setLineItemId(entry.lineItemId)
    setFields({
      location: entry.location ?? '',
      stationFrom: entry.stationFrom !== null ? String(entry.stationFrom) : '',
      stationTo: entry.stationTo !== null ? String(entry.stationTo) : '',
      quantity: String(entry.quantity),
      note: entry.note ?? '',
    })
    setFormError(null)
    stationFromRef.current?.focus()
  }

  async function handleConfirm(id: string) {
    setConfirmingId(id)
    try {
      await confirmDailyEntry(id)
      reload()
    } catch (err) {
      setFormError(errorMessage(err))
    } finally {
      setConfirmingId(null)
    }
  }

  // Split from the form's onSubmit so onKeyDown can call it directly —
  // implicit submit-on-Enter is a trusted-event-only browser heuristic that
  // doesn't fire reliably across every input in this row, and entering a
  // week of backlogged shifts needs Enter to just work everywhere in it.
  async function doSubmit() {
    setFormError(null)

    if (!userId) {
      setFormError('Not signed in.')
      return
    }
    if (!lineItemId) {
      setFormError('Choose a line item.')
      return
    }
    const qty = Number(fields.quantity)
    if (fields.quantity === '' || Number.isNaN(qty) || qty <= 0) {
      setFormError('Enter a quantity greater than zero.')
      return
    }
    const from = fields.stationFrom === '' ? null : Number(fields.stationFrom)
    if (fields.stationFrom !== '' && Number.isNaN(from)) {
      setFormError('Station From is not a valid number.')
      return
    }
    let to: number | null = null
    if (fields.stationTo !== '') {
      to = Number(fields.stationTo)
      if (Number.isNaN(to)) {
        setFormError('Station To is not a valid number.')
        return
      }
      if (from === null) {
        setFormError('Station To needs a Station From.')
        return
      }
      if (to <= from) {
        setFormError('Station To must be greater than Station From.')
        return
      }
    }

    setSubmitting(true)
    try {
      await pushDailyEntry({
        id: crypto.randomUUID(),
        projectId: project.id,
        lineItemId,
        entryDate,
        location: fields.location.trim() || null,
        quantity: qty,
        note: fields.note.trim() || null,
        status: 'draft',
        supersedes: correctingId,
        confirmedBy: null,
        confirmedAt: null,
        createdBy: userId,
        deviceId: getDeviceId(),
        createdAt: new Date().toISOString(),
        syncedAt: new Date().toISOString(),
        stationFrom: from,
        stationTo: to,
      })
      resetForm()
      stationFromRef.current?.focus()
      reload()
    } catch (err) {
      setFormError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    void doSubmit()
  }

  function handleFormKeyDown(e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    void doSubmit()
  }

  if (!isPm) {
    return (
      <div className="daily-entry-screen">
        <p className="daily-entry-denied">Desk entry is done by the project manager. Nothing to do here for your role.</p>
      </div>
    )
  }

  return (
    <div className="daily-entry-screen">
      <div className="daily-entry-header">
        <h1 className="daily-entry-title">Daily entry — {project.name}</h1>
        <label className="daily-entry-date-label" htmlFor="de-date">
          Date
        </label>
        <input
          id="de-date"
          className="daily-entry-date"
          type="date"
          value={entryDate}
          onChange={(e) => {
            setEntryDate(e.target.value)
            resetForm()
          }}
        />
      </div>

      {correctingId && (
        <div className="daily-entry-correction-banner">
          <span>Correcting a prior entry — the original stays in the total until this correction is confirmed.</span>
          <button type="button" className="daily-entry-correction-cancel" onClick={resetForm}>
            Cancel
          </button>
        </div>
      )}

      <form className="daily-entry-form" onSubmit={handleSubmit}>
        <table className="daily-entry-table">
          <thead>
            <tr>
              <th>Line item</th>
              <th>Location</th>
              <th className="daily-entry-col-right">Station from</th>
              <th className="daily-entry-col-right">Station to</th>
              <th className="daily-entry-col-right">Reach (m)</th>
              <th className="daily-entry-col-right">Quantity</th>
              <th>Note</th>
              <th />
              <th />
            </tr>
          </thead>
          <tbody>
            <tr className="daily-entry-input-row">
              <td>
                <select className="daily-entry-input" value={lineItemId} onChange={(e) => setLineItemId(e.target.value)} onKeyDown={handleFormKeyDown}>
                  {lineItems.length === 0 && <option value="">No line items</option>}
                  {lineItems.map((li) => (
                    <option key={li.id} value={li.id}>
                      {li.itemNo}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  className="daily-entry-input"
                  list="daily-entry-locations"
                  value={fields.location}
                  onChange={(e) => setFields({ ...fields, location: e.target.value })}
                  onKeyDown={handleFormKeyDown}
                />
                <datalist id="daily-entry-locations">
                  {locations.map((loc) => (
                    <option key={loc} value={loc} />
                  ))}
                </datalist>
              </td>
              <td>
                <input
                  ref={stationFromRef}
                  className="daily-entry-input daily-entry-input-mono daily-entry-col-right"
                  type="number"
                  step="0.001"
                  value={fields.stationFrom}
                  onChange={(e) => setFields({ ...fields, stationFrom: e.target.value })}
                  onKeyDown={handleFormKeyDown}
                />
              </td>
              <td>
                <input
                  className="daily-entry-input daily-entry-input-mono daily-entry-col-right"
                  type="number"
                  step="0.001"
                  value={fields.stationTo}
                  onChange={(e) => setFields({ ...fields, stationTo: e.target.value })}
                  onKeyDown={handleFormKeyDown}
                />
              </td>
              <td className="daily-entry-col-right daily-entry-input-mono daily-entry-reach">{reachMetres !== null ? reachMetres.toFixed(1) : '—'}</td>
              <td>
                <input
                  className="daily-entry-input daily-entry-input-mono daily-entry-col-right"
                  type="number"
                  step="0.01"
                  value={fields.quantity}
                  onChange={(e) => setFields({ ...fields, quantity: e.target.value })}
                  onKeyDown={handleFormKeyDown}
                />
              </td>
              <td>
                <input
                  className="daily-entry-input"
                  value={fields.note}
                  onChange={(e) => setFields({ ...fields, note: e.target.value })}
                  onKeyDown={handleFormKeyDown}
                />
              </td>
              <td>
                <button type="submit" className="daily-entry-add-btn" disabled={submitting}>
                  {submitting ? 'Adding…' : correctingId ? 'Save correction' : 'Add — Enter'}
                </button>
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </form>
      {formError && <p className="daily-entry-error">{formError}</p>}

      {status === 'loading' && <p className="daily-entry-status">Loading…</p>}
      {status === 'error' && <p className="daily-entry-error">{loadError}</p>}

      {status === 'ready' && (
        <table className="daily-entry-table daily-entry-day-list">
          <thead>
            <tr>
              <th>Line item</th>
              <th>Location</th>
              <th className="daily-entry-col-right">Station</th>
              <th className="daily-entry-col-right">Quantity</th>
              <th>Note</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td className="daily-entry-empty" colSpan={7}>
                  No entries yet for {entryDate}.
                </td>
              </tr>
            )}
            {entries.map((e) => {
              const li = lineItemById.get(e.lineItemId)
              return (
                <tr key={e.id}>
                  <td className="daily-entry-input-mono">{li?.itemNo ?? e.lineItemId.slice(0, 8)}</td>
                  <td>{e.location}</td>
                  <td className="daily-entry-col-right daily-entry-input-mono">
                    {e.stationFrom !== null ? `${e.stationFrom}${e.stationTo !== null ? `–${e.stationTo}` : ''}` : ''}
                  </td>
                  <td className="daily-entry-col-right daily-entry-input-mono">
                    {e.quantity}
                    {li ? ` ${li.unit}` : ''}
                  </td>
                  <td>{e.note}</td>
                  <td>
                    <span className={`daily-entry-chip daily-entry-chip-${e.status}`}>{e.status}</span>
                    {supersededByConfirmed.has(e.id) && <span className="daily-entry-chip daily-entry-chip-superseded">superseded</span>}
                  </td>
                  <td className="daily-entry-row-actions">
                    {e.status === 'draft' && (
                      <button type="button" className="daily-entry-row-btn" disabled={confirmingId === e.id} onClick={() => void handleConfirm(e.id)}>
                        {confirmingId === e.id ? 'Confirming…' : 'Confirm'}
                      </button>
                    )}
                    <button type="button" className="daily-entry-row-btn" onClick={() => startCorrection(e)}>
                      Correct
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
