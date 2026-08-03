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
import { Button, Card, EmptyState, Input, NotificationBanner, PageHeader, Select, StatusBadge, Textarea } from '../../components/ui'

type StationMode = 'single' | 'range'

export function EntryScreen() {
  const contract = useOutletContext<MyContract>()
  // Mirrors QuantityRecordsScreen's gate (0008: enter_quantity for an
  // original entry, correct_quantity for a correction) — this screen never
  // had one before; it presented a working-looking form to anyone who
  // reached it, relying on RLS alone to fail the write server-side. Server-
  // side RLS still is the real enforcement — this just stops the UI from
  // offering an affordance that can't work.
  const canEnter = contract.enterQuantity
  const canCorrect = contract.correctQuantity
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

  // Same either/or as QuantityRecordsScreen: entering a new original needs
  // enter_quantity, saving a correction needs correct_quantity. A seat with
  // only one of the two can still reach this screen; the rest of the form
  // stays usable, only the submit action is blocked, so a field seat never
  // sees a screen that just vanishes mid-shift.
  const formUsable = correctingId ? canCorrect : canEnter

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 p-4">
      <PageHeader title="Field entry" subtitle={contract.name} />

      {!canEnter && !canCorrect ? (
        <EmptyState title="Field entry needs enter_quantity or correct_quantity on this contract." />
      ) : (
        <>
          {chainageEntries.length > 0 && <ChainageStrip entries={chainageEntries} />}

          {loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}

          <Card className="p-4">
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              {correctingId && (
                <NotificationBanner tone="info" className="flex items-center justify-between gap-3">
                  <span>Correcting a prior entry — the original stays in the total until this correction is confirmed.</span>
                  <Button type="button" variant="ghost" onClick={() => resetForRepeat()}>
                    Cancel
                  </Button>
                </NotificationBanner>
              )}

              <div>
                <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="entry-date">
                  Date
                </label>
                <Input id="entry-date" className="nc-numeric" type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} required disabled={!formUsable} />
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="entry-item">
                  Item
                </label>
                <Select id="entry-item" value={itemId} onChange={(e) => setItemId(e.target.value)} required disabled={!formUsable}>
                  {items.length === 0 && <option value="">No items on this contract</option>}
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.itemNumber} — {item.description}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="flex gap-2" role="group" aria-label="Station mode">
                <Button type="button" variant={mode === 'single' ? 'primary' : 'secondary'} className="flex-1" onClick={() => setMode('single')} disabled={!formUsable}>
                  Single station
                </Button>
                <Button type="button" variant={mode === 'range' ? 'primary' : 'secondary'} className="flex-1" onClick={() => setMode('range')} disabled={!formUsable}>
                  From – To
                </Button>
              </div>

              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="entry-station-from">
                    Station {mode === 'range' ? 'From' : ''}
                  </label>
                  <Input
                    id="entry-station-from"
                    className="nc-numeric"
                    type="number"
                    inputMode="decimal"
                    step="0.001"
                    value={stationFrom}
                    onChange={(e) => setStationFrom(e.target.value)}
                    disabled={!formUsable}
                  />
                </div>
                {mode === 'range' && (
                  <div className="flex-1">
                    <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="entry-station-to">
                      Station To
                    </label>
                    <Input
                      id="entry-station-to"
                      className="nc-numeric"
                      type="number"
                      inputMode="decimal"
                      step="0.001"
                      value={stationTo}
                      onChange={(e) => setStationTo(e.target.value)}
                      disabled={!formUsable}
                    />
                  </div>
                )}
              </div>
              {mode === 'range' && <p className="nc-numeric -mt-1 min-h-[1.2em] text-sm text-nc-accent">{reachMetres !== null ? `reach ${reachMetres.toFixed(1)} m` : ' '}</p>}

              <div>
                <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="entry-quantity">
                  Quantity{selectedItem ? ` (${selectedItem.unit})` : ''}
                </label>
                <Input
                  id="entry-quantity"
                  className="nc-numeric"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  required
                  disabled={!formUsable}
                />
                {selectedItem && isLumpUnit(selectedItem.unit) && <p className="mt-1 text-xs text-nc-text-muted">Lump-sum item — quantity is a % or portion complete, per contract convention.</p>}
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="entry-location">
                  Location
                </label>
                <Input
                  id="entry-location"
                  list="entry-location-options"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Free text — e.g. Sta 12+400 south shoulder"
                  disabled={!formUsable}
                />
                <datalist id="entry-location-options">
                  {locations.map((loc) => (
                    <option key={loc} value={loc} />
                  ))}
                </datalist>
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="entry-note">
                  Note
                </label>
                <Textarea id="entry-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} disabled={!formUsable} />
              </div>

              {formError && <NotificationBanner tone="danger">{formError}</NotificationBanner>}

              <Button
                type="submit"
                disabled={submitting || !formUsable}
                title={!formUsable ? `Needs ${correctingId ? 'correct_quantity' : 'enter_quantity'}` : undefined}
              >
                {submitting ? 'Saving…' : !formUsable ? 'Not permitted' : correctingId ? 'Save correction' : 'Add entry'}
              </Button>
            </form>
          </Card>

          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-nc-text-muted">{workDate}</h2>
            {dayRecords.length === 0 && <p className="text-sm text-nc-text-subtle">No entries yet today.</p>}
            {dayRecords.map((r) => {
              const item = itemById.get(r.itemId)
              return (
                <Card key={r.id} className="flex flex-col gap-1 p-3">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <span className="font-semibold text-nc-text">{item?.itemNumber ?? r.itemId.slice(0, 8)}</span>
                    <span className="nc-numeric text-sm text-nc-text-muted">
                      {r.quantity}
                      {item ? ` ${item.unit}` : ''}
                    </span>
                    {r.stationFrom !== null && (
                      <span className="nc-numeric text-sm text-nc-text-muted">
                        {r.stationFrom}
                        {r.stationTo !== null ? `–${r.stationTo}` : ''}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {r.location && <span className="text-xs text-nc-text-subtle">{r.location}</span>}
                    <StatusBadge status={r.status} />
                    {r.pending && <StatusBadge status="correcting">queued</StatusBadge>}
                    {supersededByConfirmed.has(r.id) && <StatusBadge status="superseded" />}
                  </div>
                  <div className="mt-1 flex gap-2">
                    {r.status === 'draft' && r.pending === false && (
                      <Button type="button" variant="secondary" disabled={confirmingId === r.id || !contract.confirmQuantity} onClick={() => void handleConfirm(r.id)}>
                        {confirmingId === r.id ? 'Confirming…' : 'Confirm'}
                      </Button>
                    )}
                    <Button type="button" variant="secondary" disabled={!canCorrect} onClick={() => startCorrection(r)}>
                      Correct
                    </Button>
                  </div>
                </Card>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
