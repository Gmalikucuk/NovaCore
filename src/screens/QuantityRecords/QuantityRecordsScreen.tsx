import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { MyContract } from '../../lib/supabase/contracts'
import { useSession } from '../../lib/useSession'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { confirmQuantityRecord, fetchDistinctLocations, fetchQuantityRecordsForDate, pushQuantityRecord } from '../../lib/supabase/quantityRecords'
import type { QueuedQuantityRecord } from '../../lib/db'
import { getDeviceId } from '../../lib/deviceId'
import { errorMessage } from '../../lib/errorMessage'
import { todayLocalDateString } from '../../lib/dateFormat'
import './QuantityRecordsScreen.css'

type DayRecord = Omit<QueuedQuantityRecord, 'pending' | 'lastError'>

const BLANK = { location: '', stationFrom: '', stationTo: '', quantity: '', note: '' }

export function QuantityRecordsScreen() {
  const contract = useOutletContext<MyContract>()
  // enter_quantity covers an ORIGINAL entry (supersedes null); correct_quantity
  // covers a CORRECTION (supersedes set) — mirrors quantity_records_insert_right
  // (0008) exactly. Either one alone reaches this screen; which half of the
  // form is usable depends on which mode it's in (see formUsable below).
  const canEnter = contract.enterQuantity
  const canCorrect = contract.correctQuantity
  const session = useSession()
  const userId = session?.user.id ?? null

  const [workDate, setWorkDate] = useState(todayLocalDateString())
  const [items, setItems] = useState<Item[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [records, setRecords] = useState<DayRecord[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [itemId, setItemId] = useState('')
  const [fields, setFields] = useState(BLANK)
  const [correctingId, setCorrectingId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const stationFromRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchItems(contract.id)
      .then((rows) => {
        setItems(rows)
        setItemId((prev) => prev || rows[0]?.id || '')
      })
      .catch((err: unknown) => setLoadError(errorMessage(err)))
    fetchDistinctLocations(contract.id)
      .then(setLocations)
      .catch(() => {
        /* autocomplete only — not worth surfacing as a page error */
      })
  }, [contract.id])

  function reload() {
    setStatus('loading')
    fetchQuantityRecordsForDate(contract.id, workDate)
      .then((rows) => {
        setRecords(rows)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }

  useEffect(reload, [contract.id, workDate])

  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])

  const supersededByConfirmed = useMemo(() => {
    const set = new Set<string>()
    for (const r of records) {
      if (r.supersedes && r.status === 'confirmed') set.add(r.supersedes)
    }
    return set
  }, [records])

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

  function startCorrection(record: DayRecord) {
    setCorrectingId(record.id)
    setItemId(record.itemId)
    setFields({
      location: record.location ?? '',
      stationFrom: record.stationFrom !== null ? String(record.stationFrom) : '',
      stationTo: record.stationTo !== null ? String(record.stationTo) : '',
      quantity: String(record.quantity),
      note: record.note ?? '',
    })
    setFormError(null)
    stationFromRef.current?.focus()
  }

  async function handleConfirm(id: string) {
    setConfirmingId(id)
    try {
      await confirmQuantityRecord(id)
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
    if (!itemId) {
      setFormError('Choose an item.')
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
      await pushQuantityRecord({
        id: crypto.randomUUID(),
        contractId: contract.id,
        itemId,
        workDate,
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

  if (!canEnter && !canCorrect) {
    return (
      <div className="quantity-records-screen">
        <p className="quantity-records-denied">Desk entry needs enter_quantity or correct_quantity on this contract.</p>
      </div>
    )
  }

  // Which half of the form is live depends on the row's mode, not a single
  // screen-wide flag: entering a new original needs enter_quantity, saving a
  // correction needs correct_quantity. A seat with only one of the two can
  // still reach this screen (see the gate above) — the other half stays
  // visible but disabled rather than the screen being hidden outright, per
  // 0008's UI-gating rule (disabled/read-only over hidden).
  const formUsable = correctingId ? canCorrect : canEnter

  return (
    <div className="quantity-records-screen">
      <div className="quantity-records-header">
        <h1 className="quantity-records-title">Daily entry — {contract.name}</h1>
        <label className="quantity-records-date-label" htmlFor="de-date">
          Date
        </label>
        <input
          id="de-date"
          className="quantity-records-date"
          type="date"
          value={workDate}
          onChange={(e) => {
            setWorkDate(e.target.value)
            resetForm()
          }}
        />
      </div>

      {correctingId && (
        <div className="quantity-records-correction-banner">
          <span>Correcting a prior entry — the original stays in the total until this correction is confirmed.</span>
          <button type="button" className="quantity-records-correction-cancel" onClick={resetForm}>
            Cancel
          </button>
        </div>
      )}

      <form className="quantity-records-form" onSubmit={handleSubmit}>
        <table className="quantity-records-table">
          <thead>
            <tr>
              <th>Item #</th>
              <th>Location</th>
              <th className="quantity-records-col-right">Station from</th>
              <th className="quantity-records-col-right">Station to</th>
              <th className="quantity-records-col-right">Reach (m)</th>
              <th className="quantity-records-col-right">Quantity</th>
              <th>Note</th>
              <th />
              <th />
            </tr>
          </thead>
          <tbody>
            <tr className="quantity-records-input-row">
              <td>
                <select
                  className="quantity-records-input"
                  value={itemId}
                  onChange={(e) => setItemId(e.target.value)}
                  onKeyDown={handleFormKeyDown}
                  disabled={!formUsable}
                >
                  {items.length === 0 && <option value="">No items</option>}
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.itemNumber}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  className="quantity-records-input"
                  list="quantity-records-locations"
                  value={fields.location}
                  onChange={(e) => setFields({ ...fields, location: e.target.value })}
                  onKeyDown={handleFormKeyDown}
                  disabled={!formUsable}
                />
                <datalist id="quantity-records-locations">
                  {locations.map((loc) => (
                    <option key={loc} value={loc} />
                  ))}
                </datalist>
              </td>
              <td>
                <input
                  ref={stationFromRef}
                  className="quantity-records-input quantity-records-input-mono quantity-records-col-right"
                  type="number"
                  step="0.001"
                  value={fields.stationFrom}
                  onChange={(e) => setFields({ ...fields, stationFrom: e.target.value })}
                  onKeyDown={handleFormKeyDown}
                  disabled={!formUsable}
                />
              </td>
              <td>
                <input
                  className="quantity-records-input quantity-records-input-mono quantity-records-col-right"
                  type="number"
                  step="0.001"
                  value={fields.stationTo}
                  onChange={(e) => setFields({ ...fields, stationTo: e.target.value })}
                  onKeyDown={handleFormKeyDown}
                  disabled={!formUsable}
                />
              </td>
              <td className="quantity-records-col-right quantity-records-input-mono quantity-records-reach">{reachMetres !== null ? reachMetres.toFixed(1) : '—'}</td>
              <td>
                <input
                  className="quantity-records-input quantity-records-input-mono quantity-records-col-right"
                  type="number"
                  step="0.01"
                  value={fields.quantity}
                  onChange={(e) => setFields({ ...fields, quantity: e.target.value })}
                  onKeyDown={handleFormKeyDown}
                  disabled={!formUsable}
                />
              </td>
              <td>
                <input
                  className="quantity-records-input"
                  value={fields.note}
                  onChange={(e) => setFields({ ...fields, note: e.target.value })}
                  onKeyDown={handleFormKeyDown}
                  disabled={!formUsable}
                />
              </td>
              <td>
                <button type="submit" className="quantity-records-add-btn" disabled={submitting || !formUsable} title={!formUsable ? `Needs ${correctingId ? 'correct_quantity' : 'enter_quantity'}` : undefined}>
                  {submitting ? 'Adding…' : !formUsable ? 'Not permitted' : correctingId ? 'Save correction' : 'Add — Enter'}
                </button>
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </form>
      {formError && <p className="quantity-records-error">{formError}</p>}

      {status === 'loading' && <p className="quantity-records-status">Loading…</p>}
      {status === 'error' && <p className="quantity-records-error">{loadError}</p>}

      {status === 'ready' && (
        <table className="quantity-records-table quantity-records-day-list">
          <thead>
            <tr>
              <th>Item #</th>
              <th>Location</th>
              <th className="quantity-records-col-right">Station</th>
              <th className="quantity-records-col-right">Quantity</th>
              <th>Note</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {records.length === 0 && (
              <tr>
                <td className="quantity-records-empty" colSpan={7}>
                  No entries yet for {workDate}.
                </td>
              </tr>
            )}
            {records.map((r) => {
              const item = itemById.get(r.itemId)
              return (
                <tr key={r.id}>
                  <td className="quantity-records-input-mono">{item?.itemNumber ?? r.itemId.slice(0, 8)}</td>
                  <td>{r.location}</td>
                  <td className="quantity-records-col-right quantity-records-input-mono">
                    {r.stationFrom !== null ? `${r.stationFrom}${r.stationTo !== null ? `–${r.stationTo}` : ''}` : ''}
                  </td>
                  <td className="quantity-records-col-right quantity-records-input-mono">
                    {r.quantity}
                    {item ? ` ${item.unit}` : ''}
                  </td>
                  <td>{r.note}</td>
                  <td>
                    <span className={`quantity-records-chip quantity-records-chip-${r.status}`}>{r.status}</span>
                    {supersededByConfirmed.has(r.id) && <span className="quantity-records-chip quantity-records-chip-superseded">superseded</span>}
                  </td>
                  <td className="quantity-records-row-actions">
                    {r.status === 'draft' && (
                      <button
                        type="button"
                        className="quantity-records-row-btn"
                        disabled={confirmingId === r.id || !contract.confirmQuantity}
                        title={!contract.confirmQuantity ? 'Needs confirm_quantity' : undefined}
                        onClick={() => void handleConfirm(r.id)}
                      >
                        {confirmingId === r.id ? 'Confirming…' : 'Confirm'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="quantity-records-row-btn"
                      disabled={!canCorrect}
                      title={!canCorrect ? 'Needs correct_quantity' : undefined}
                      onClick={() => startCorrection(r)}
                    >
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
