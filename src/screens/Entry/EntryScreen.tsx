import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { MyContract } from '../../lib/supabase/contracts'
import { useSession } from '../../lib/useSession'
import { useLiveQuery } from '../../lib/sync/useLiveQuery'
import { db, type QueuedQuantityRecord } from '../../lib/db'
import { enqueueQuantityRecord, importServerQuantityRecords, registerSyncListeners, syncQueuedQuantityRecords } from '../../lib/sync/quantityRecordsSync'
import { confirmQuantityRecord, fetchDistinctLocations, isLumpUnit } from '../../lib/supabase/quantityRecords'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { getDeviceId } from '../../lib/deviceId'
import { errorMessage } from '../../lib/errorMessage'
import { todayLocalDateString } from '../../lib/dateFormat'
import { ChainageStrip, type ChainageEntry } from '../../components/ChainageStrip'
import './EntryScreen.css'

type StationMode = 'single' | 'range'

export function EntryScreen() {
  const contract = useOutletContext<MyContract>()
  const session = useSession()
  const userId = session?.user.id ?? null

  const [items, setItems] = useState<Item[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const [workDate, setWorkDate] = useState(todayLocalDateString())
  const [itemId, setItemId] = useState('')
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
    void importServerQuantityRecords(contract.id).catch((err: unknown) => {
      // Offline on first load is fine — the local queue table still serves
      // whatever was imported last time. Only surfaced if there's nothing
      // local to fall back on.
      console.warn('importServerQuantityRecords failed (likely offline):', err)
    })
    // Drains anything still queued from a previous session (e.g. the app
    // was killed mid-sync) — registerSyncListeners only retries on a later
    // 'online'/'visibilitychange' event, which may never fire if the device
    // was already online and the tab was already visible on reload.
    void syncQueuedQuantityRecords()
    Promise.all([fetchItems(contract.id), fetchDistinctLocations(contract.id)])
      .then(([itemRows, locs]) => {
        setItems(itemRows)
        setLocations(locs)
        if (itemRows.length > 0) setItemId((prev) => prev || itemRows[0].id)
      })
      .catch((err: unknown) => setLoadError(errorMessage(err)))
  }, [contract.id])

  const dayRecords = useLiveQuery(
    () => db.quantityRecords.where('contractId').equals(contract.id).and((r) => r.workDate === workDate).sortBy('createdAt'),
    [contract.id, workDate],
    [] as QueuedQuantityRecord[],
  )

  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const selectedItem = itemById.get(itemId)

  const supersededByConfirmed = useMemo(() => {
    const set = new Set<string>()
    for (const r of dayRecords) {
      if (r.supersedes && r.status === 'confirmed') set.add(r.supersedes)
    }
    return set
  }, [dayRecords])

  const reachMetres = useMemo(() => {
    if (mode !== 'range') return null
    const from = Number(stationFrom)
    const to = Number(stationTo)
    if (stationFrom === '' || stationTo === '' || Number.isNaN(from) || Number.isNaN(to)) return null
    return to - from
  }, [mode, stationFrom, stationTo])

  const chainageEntries: ChainageEntry[] = useMemo(
    () =>
      dayRecords
        .filter((r) => r.stationFrom !== null)
        .map((r) => ({
          id: r.id,
          stationFrom: r.stationFrom as number,
          stationTo: r.stationTo,
          status: r.status,
          itemNumber: itemById.get(r.itemId)?.itemNumber ?? '?',
          quantity: r.quantity,
        })),
    [dayRecords, itemById],
  )

  function resetForRepeat() {
    setStationFrom('')
    setStationTo('')
    setQuantity('')
    setNote('')
    setCorrectingId(null)
  }

  function startCorrection(record: QueuedQuantityRecord) {
    setCorrectingId(record.id)
    setWorkDate(record.workDate)
    setItemId(record.itemId)
    setMode(record.stationTo !== null ? 'range' : 'single')
    setStationFrom(record.stationFrom !== null ? String(record.stationFrom) : '')
    setStationTo(record.stationTo !== null ? String(record.stationTo) : '')
    setQuantity(String(record.quantity))
    setNote(record.note ?? '')
    setLocation(record.location ?? '')
    setFormError(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function handleConfirm(id: string) {
    setConfirmingId(id)
    try {
      await confirmQuantityRecord(id)
      await importServerQuantityRecords(contract.id)
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
    if (!itemId) {
      setFormError('Choose an item.')
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
      await enqueueQuantityRecord({
        id: crypto.randomUUID(),
        contractId: contract.id,
        itemId,
        workDate,
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
        <input id="entry-date" className="entry-input entry-input-mono" type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} required />

        <label className="entry-label" htmlFor="entry-item">
          Item
        </label>
        <select id="entry-item" className="entry-input" value={itemId} onChange={(e) => setItemId(e.target.value)} required>
          {items.length === 0 && <option value="">No items on this contract</option>}
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.itemNumber} — {item.description}
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
        {mode === 'range' && <p className="entry-reach-readout">{reachMetres !== null ? `reach ${reachMetres.toFixed(1)} m` : ' '}</p>}

        <label className="entry-label" htmlFor="entry-quantity">
          Quantity{selectedItem ? ` (${selectedItem.unit})` : ''}
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
        {selectedItem && isLumpUnit(selectedItem.unit) && <p className="entry-hint">Lump-sum item — quantity is a % or portion complete, per contract convention.</p>}

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
        <h2 className="entry-day-list-title">{workDate}</h2>
        {dayRecords.length === 0 && <p className="entry-day-list-empty">No entries yet today.</p>}
        {dayRecords.map((r) => {
          const item = itemById.get(r.itemId)
          return (
            <div key={r.id} className="entry-row">
              <div className="entry-row-main">
                <span className="entry-row-item">{item?.itemNumber ?? r.itemId.slice(0, 8)}</span>
                <span className="entry-row-quantity entry-input-mono">
                  {r.quantity}
                  {item ? ` ${item.unit}` : ''}
                </span>
                {r.stationFrom !== null && (
                  <span className="entry-row-station entry-input-mono">
                    {r.stationFrom}
                    {r.stationTo !== null ? `–${r.stationTo}` : ''}
                  </span>
                )}
              </div>
              <div className="entry-row-meta">
                {r.location && <span className="entry-row-location">{r.location}</span>}
                <span className={`entry-chip entry-chip-${r.status}`}>{r.status}</span>
                {r.pending && <span className="entry-chip entry-chip-pending">queued</span>}
                {supersededByConfirmed.has(r.id) && <span className="entry-chip entry-chip-superseded">superseded</span>}
              </div>
              <div className="entry-row-actions">
                {r.status === 'draft' && r.pending === false && (
                  <button type="button" className="entry-row-btn" disabled={confirmingId === r.id} onClick={() => void handleConfirm(r.id)}>
                    {confirmingId === r.id ? 'Confirming…' : 'Confirm'}
                  </button>
                )}
                <button type="button" className="entry-row-btn" onClick={() => startCorrection(r)}>
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
