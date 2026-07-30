import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { MyProject } from '../../lib/supabase/projects'
import { useSession } from '../../lib/useSession'
import { useLiveQuery } from '../../lib/sync/useLiveQuery'
import { db, type QueuedDailyEntry } from '../../lib/db'
import { enqueueEntry, importServerEntries, registerSyncListeners, syncQueuedEntries } from '../../lib/sync/dailyEntriesSync'
import { confirmDailyEntry, fetchDistinctLocations, fetchLineItems, isLumpUnit, type LineItem } from '../../lib/supabase/entries'
import { getDeviceId } from '../../lib/deviceId'
import { errorMessage } from '../../lib/errorMessage'
import { todayLocalDateString } from '../../lib/dateFormat'
import { ChainageStrip, type ChainageEntry } from '../../components/ChainageStrip'
import './EntryScreen.css'

type StationMode = 'single' | 'range'

export function EntryScreen() {
  const project = useOutletContext<MyProject>()
  const session = useSession()
  const userId = session?.user.id ?? null

  const [lineItems, setLineItems] = useState<LineItem[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const [entryDate, setEntryDate] = useState(todayLocalDateString())
  const [lineItemId, setLineItemId] = useState('')
  const [mode, setMode] = useState<StationMode>('range')
  const [stationFrom, setStationFrom] = useState('')
  const [stationTo, setStationTo] = useState('')
  const [quantity, setQuantity] = useState('')
  const [note, setNote] = useState('')
  const [location, setLocation] = useState('')
  const [correctingId, setCorrectingId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  useEffect(() => {
    registerSyncListeners()
  }, [])

  useEffect(() => {
    setLoadError(null)
    void importServerEntries(project.id).catch((err: unknown) => {
      // Offline on first load is fine — the local queue table still serves
      // whatever was imported last time. Only surfaced if there's nothing
      // local to fall back on.
      console.warn('importServerEntries failed (likely offline):', err)
    })
    // Drains anything still queued from a previous session (e.g. the app
    // was killed mid-sync) — registerSyncListeners only retries on a later
    // 'online'/'visibilitychange' event, which may never fire if the device
    // was already online and the tab was already visible on reload.
    void syncQueuedEntries()
    Promise.all([fetchLineItems(project.id), fetchDistinctLocations(project.id)])
      .then(([items, locs]) => {
        setLineItems(items)
        setLocations(locs)
        if (items.length > 0) setLineItemId((prev) => prev || items[0].id)
      })
      .catch((err: unknown) => setLoadError(errorMessage(err)))
  }, [project.id])

  const dayEntries = useLiveQuery(
    () => db.dailyEntries.where('projectId').equals(project.id).and((e) => e.entryDate === entryDate).sortBy('createdAt'),
    [project.id, entryDate],
    [] as QueuedDailyEntry[],
  )

  const lineItemById = useMemo(() => new Map(lineItems.map((li) => [li.id, li])), [lineItems])
  const selectedLineItem = lineItemById.get(lineItemId)

  const supersededByConfirmed = useMemo(() => {
    const set = new Set<string>()
    for (const e of dayEntries) {
      if (e.supersedes && e.status === 'confirmed') set.add(e.supersedes)
    }
    return set
  }, [dayEntries])

  const reachMetres = useMemo(() => {
    if (mode !== 'range') return null
    const from = Number(stationFrom)
    const to = Number(stationTo)
    if (stationFrom === '' || stationTo === '' || Number.isNaN(from) || Number.isNaN(to)) return null
    return to - from
  }, [mode, stationFrom, stationTo])

  const chainageEntries: ChainageEntry[] = useMemo(
    () =>
      dayEntries
        .filter((e) => e.stationFrom !== null)
        .map((e) => ({
          id: e.id,
          stationFrom: e.stationFrom as number,
          stationTo: e.stationTo,
          status: e.status,
          itemNo: lineItemById.get(e.lineItemId)?.itemNo ?? '?',
          quantity: e.quantity,
        })),
    [dayEntries, lineItemById],
  )

  function resetForRepeat() {
    setStationFrom('')
    setStationTo('')
    setQuantity('')
    setNote('')
    setCorrectingId(null)
  }

  function startCorrection(entry: QueuedDailyEntry) {
    setCorrectingId(entry.id)
    setEntryDate(entry.entryDate)
    setLineItemId(entry.lineItemId)
    setMode(entry.stationTo !== null ? 'range' : 'single')
    setStationFrom(entry.stationFrom !== null ? String(entry.stationFrom) : '')
    setStationTo(entry.stationTo !== null ? String(entry.stationTo) : '')
    setQuantity(String(entry.quantity))
    setNote(entry.note ?? '')
    setLocation(entry.location ?? '')
    setFormError(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function handleConfirm(id: string) {
    setConfirmingId(id)
    try {
      await confirmDailyEntry(id)
      await importServerEntries(project.id)
    } catch (err) {
      setFormError(errorMessage(err))
    } finally {
      setConfirmingId(null)
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)

    if (!userId) {
      setFormError('Not signed in.')
      return
    }
    if (!lineItemId) {
      setFormError('Choose a line item.')
      return
    }
    const qty = Number(quantity)
    if (quantity === '' || Number.isNaN(qty) || qty <= 0) {
      setFormError('Enter a quantity greater than zero.')
      return
    }
    const from = stationFrom === '' ? null : Number(stationFrom)
    if (stationFrom !== '' && Number.isNaN(from)) {
      setFormError('Station From is not a valid number.')
      return
    }
    let to: number | null = null
    if (mode === 'range') {
      if (stationTo === '') {
        setFormError('Enter a Station To, or switch to single-station mode.')
        return
      }
      to = Number(stationTo)
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
      await enqueueEntry({
        id: crypto.randomUUID(),
        projectId: project.id,
        lineItemId,
        entryDate,
        location: location.trim() || null,
        quantity: qty,
        note: note.trim() || null,
        supersedes: correctingId,
        createdBy: userId,
        deviceId: getDeviceId(),
        stationFrom: from,
        stationTo: to,
      })
      resetForRepeat()
    } catch (err) {
      setFormError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="entry-screen">
      {chainageEntries.length > 0 && <ChainageStrip entries={chainageEntries} />}

      {loadError && <p className="entry-screen-error">{loadError}</p>}

      <form className="entry-form" onSubmit={handleSubmit}>
        {correctingId && (
          <div className="entry-correction-banner">
            <span>Correcting a prior entry — the original stays in the total until this correction is confirmed.</span>
            <button type="button" className="entry-correction-cancel" onClick={() => resetForRepeat()}>
              Cancel
            </button>
          </div>
        )}

        <label className="entry-label" htmlFor="entry-date">
          Date
        </label>
        <input id="entry-date" className="entry-input entry-input-mono" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} required />

        <label className="entry-label" htmlFor="entry-line-item">
          Line item
        </label>
        <select id="entry-line-item" className="entry-input" value={lineItemId} onChange={(e) => setLineItemId(e.target.value)} required>
          {lineItems.length === 0 && <option value="">No line items on this project</option>}
          {lineItems.map((li) => (
            <option key={li.id} value={li.id}>
              {li.itemNo} — {li.description}
            </option>
          ))}
        </select>

        <div className="entry-station-toggle" role="group" aria-label="Station mode">
          <button type="button" className={mode === 'single' ? 'entry-toggle-btn entry-toggle-active' : 'entry-toggle-btn'} onClick={() => setMode('single')}>
            Single station
          </button>
          <button type="button" className={mode === 'range' ? 'entry-toggle-btn entry-toggle-active' : 'entry-toggle-btn'} onClick={() => setMode('range')}>
            From – To
          </button>
        </div>

        <div className="entry-station-row">
          <div className="entry-station-field">
            <label className="entry-label" htmlFor="entry-station-from">
              Station {mode === 'range' ? 'From' : ''}
            </label>
            <input
              id="entry-station-from"
              className="entry-input entry-input-mono"
              type="number"
              inputMode="decimal"
              step="0.001"
              value={stationFrom}
              onChange={(e) => setStationFrom(e.target.value)}
            />
          </div>
          {mode === 'range' && (
            <div className="entry-station-field">
              <label className="entry-label" htmlFor="entry-station-to">
                Station To
              </label>
              <input
                id="entry-station-to"
                className="entry-input entry-input-mono"
                type="number"
                inputMode="decimal"
                step="0.001"
                value={stationTo}
                onChange={(e) => setStationTo(e.target.value)}
              />
            </div>
          )}
        </div>
        {mode === 'range' && <p className="entry-reach-readout">{reachMetres !== null ? `reach ${reachMetres.toFixed(1)} m` : ' '}</p>}

        <label className="entry-label" htmlFor="entry-quantity">
          Quantity{selectedLineItem ? ` (${selectedLineItem.unit})` : ''}
        </label>
        <input
          id="entry-quantity"
          className="entry-input entry-input-mono"
          type="number"
          inputMode="decimal"
          step="0.01"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          required
        />
        {selectedLineItem && isLumpUnit(selectedLineItem.unit) && <p className="entry-hint">Lump-sum item — quantity is a % or portion complete, per project convention.</p>}

        <label className="entry-label" htmlFor="entry-location">
          Location
        </label>
        <input
          id="entry-location"
          className="entry-input"
          list="entry-location-options"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Free text — e.g. Sta 12+400 south shoulder"
        />
        <datalist id="entry-location-options">
          {locations.map((loc) => (
            <option key={loc} value={loc} />
          ))}
        </datalist>

        <label className="entry-label" htmlFor="entry-note">
          Note
        </label>
        <textarea id="entry-note" className="entry-input entry-textarea" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />

        {formError && <p className="entry-form-error">{formError}</p>}

        <button className="entry-submit" type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : correctingId ? 'Save correction' : 'Add entry'}
        </button>
      </form>

      <div className="entry-day-list">
        <h2 className="entry-day-list-title">{entryDate}</h2>
        {dayEntries.length === 0 && <p className="entry-day-list-empty">No entries yet today.</p>}
        {dayEntries.map((e) => {
          const li = lineItemById.get(e.lineItemId)
          return (
            <div key={e.id} className="entry-row">
              <div className="entry-row-main">
                <span className="entry-row-item">{li?.itemNo ?? e.lineItemId.slice(0, 8)}</span>
                <span className="entry-row-quantity entry-input-mono">
                  {e.quantity}
                  {li ? ` ${li.unit}` : ''}
                </span>
                {e.stationFrom !== null && (
                  <span className="entry-row-station entry-input-mono">
                    {e.stationFrom}
                    {e.stationTo !== null ? `–${e.stationTo}` : ''}
                  </span>
                )}
              </div>
              <div className="entry-row-meta">
                {e.location && <span className="entry-row-location">{e.location}</span>}
                <span className={`entry-chip entry-chip-${e.status}`}>{e.status}</span>
                {e.pending && <span className="entry-chip entry-chip-pending">queued</span>}
                {supersededByConfirmed.has(e.id) && <span className="entry-chip entry-chip-superseded">superseded</span>}
              </div>
              <div className="entry-row-actions">
                {e.status === 'draft' && e.pending === false && (
                  <button type="button" className="entry-row-btn" disabled={confirmingId === e.id} onClick={() => void handleConfirm(e.id)}>
                    {confirmingId === e.id ? 'Confirming…' : 'Confirm'}
                  </button>
                )}
                <button type="button" className="entry-row-btn" onClick={() => startCorrection(e)}>
                  Correct
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
