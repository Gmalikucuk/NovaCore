import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconAlertTriangle, IconCalendarPlus } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { useSession } from '../../lib/useSession'
import { useLiveQuery } from '../../lib/sync/useLiveQuery'
import { db, type QueuedQuantityRecord } from '../../lib/db'
import { enqueueQuantityRecord, importServerQuantityRecords, registerSyncListeners, syncQueuedQuantityRecords } from '../../lib/sync/quantityRecordsSync'
import { confirmQuantityRecord, fetchDistinctLocations } from '../../lib/supabase/quantityRecords'
import { fetchItems, isUnitPriceItem, type Item } from '../../lib/supabase/items'
import { fetchItemProgress, type ItemProgress } from '../../lib/supabase/monthlyPeriods'
import { getDeviceId } from '../../lib/deviceId'
import { errorMessage } from '../../lib/errorMessage'
import { formatDayLabel, todayLocalDateString } from '../../lib/dateFormat'
import { ChainageStrip, type ChainageEntry } from '../../components/ChainageStrip'
import { Button, EmptyState, Input, NotificationBanner, StatusBadge, Textarea } from '../../components/ui'
import { quantity as fmtQuantity, parseStation, station } from '../../lib/format'

type StationMode = 'single' | 'range'
type ScreenMode = 'list' | 'picker' | 'form'

/**
 * Today's work, not the form. The same inversion as desktop Daily Entry,
 * for the same reason: a permanently-open seven-field form docked above
 * the day's list buries the one thing that matters (what's been entered
 * today) on the screen where vertical space is scarcest. The list leads;
 * Add is a single action that opens a recency-sorted, searchable picker
 * (fetchItemProgress's ordering, the same one this screen already used
 * inside its old always-open Select), then the form for whichever Item
 * was chosen.
 *
 * The date signal here is the priority, not the layout — see the sticky
 * cluster at the top of the render. Backfilling is routine and highest-
 * risk on exactly this surface (a phone, at the end of a shift), so the
 * date and the "not today" state stay on screen at every scroll position,
 * including while the form is open — not only before it.
 */
export function EntryScreen() {
  const contract = useOutletContext<MyContract>()
  // Mirrors desktop Daily Entry's gate (0008: enter_quantity for an
  // original entry, correct_quantity for a correction).
  const canEnter = contract.enterQuantity
  const canCorrect = contract.correctQuantity
  const session = useSession()
  const userId = session?.user.id ?? null

  const [items, setItems] = useState<Item[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [itemProgress, setItemProgress] = useState<ItemProgress[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const [workDate, setWorkDate] = useState(todayLocalDateString())

  // list: today's records, the default and where every flow returns to.
  // picker: searching for an Item to add against. form: the entry fields,
  // for either a fresh add (itemId set by the picker) or a correction
  // (itemId set from the record being corrected). Never opens straight
  // into picker or form — arriving here, or landing on a quiet day, shows
  // the day first.
  const [screenMode, setScreenMode] = useState<ScreenMode>('list')
  const [pickerSearch, setPickerSearch] = useState('')
  const [itemId, setItemId] = useState('')
  const [stationMode, setStationMode] = useState<StationMode>('range')
  const [stationFrom, setStationFrom] = useState('')
  const [stationTo, setStationTo] = useState('')
  const [quantity, setQuantity] = useState('')
  const [note, setNote] = useState('')
  const [location, setLocation] = useState('')
  const [correctingId, setCorrectingId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const pickerSearchRef = useRef<HTMLInputElement>(null)
  const stationFromRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    registerSyncListeners()
  }, [])

  useEffect(() => {
    setLoadError(null)
    void importServerQuantityRecords(contract.id).catch((err: unknown) => {
      console.warn('importServerQuantityRecords failed (likely offline):', err)
    })
    void syncQueuedQuantityRecords()
    Promise.all([fetchItems(contract.id), fetchDistinctLocations(contract.id)])
      .then(([itemRows, locs]) => {
        setItems(itemRows)
        setLocations(locs)
      })
      .catch((err: unknown) => setLoadError(errorMessage(err)))
    // Drives the Add picker's recency sort only — offline or slow, the
    // picker still works, just unsorted.
    fetchItemProgress(contract.id)
      .then((rows) => setItemProgress(rows))
      .catch((err: unknown) => {
        console.warn('fetchItemProgress failed (likely offline) — item picker will be unsorted:', err)
      })
  }, [contract.id])

  const dayRecords = useLiveQuery(
    () => db.quantityRecords.where('contractId').equals(contract.id).and((r) => r.workDate === workDate).sortBy('createdAt'),
    [contract.id, workDate],
    [] as QueuedQuantityRecord[],
  )

  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const selectedItem = itemById.get(itemId)

  const progressByItemId = useMemo(() => new Map(itemProgress.map((p) => [p.itemId, p])), [itemProgress])

  // Only Unit Price Items are enterable (GC 52.03(b)/(c) pay Lump Sum/
  // Provisional Sum on a basis a quantity reading doesn't express), sorted
  // by recent activity on this contract, not alphabetically — the exact
  // ordering this screen's own old always-open Select already used.
  const pickableItems = useMemo(() => {
    const unitPriced = items.filter(isUnitPriceItem)
    return [...unitPriced].sort((a, b) => {
      const aDate = progressByItemId.get(a.id)?.lastWorkDate ?? null
      const bDate = progressByItemId.get(b.id)?.lastWorkDate ?? null
      if (aDate !== null && bDate !== null) return bDate.localeCompare(aDate)
      if (aDate !== null) return -1
      if (bDate !== null) return 1
      return a.itemNumber.localeCompare(b.itemNumber)
    })
  }, [items, progressByItemId])

  const filteredPickableItems = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase()
    if (!q) return pickableItems
    return pickableItems.filter((i) => i.itemNumber.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
  }, [pickableItems, pickerSearch])

  const supersededByConfirmed = useMemo(() => {
    const set = new Set<string>()
    for (const r of dayRecords) {
      if (r.supersedes && r.status === 'confirmed') set.add(r.supersedes)
    }
    return set
  }, [dayRecords])

  const recordById = useMemo(() => new Map(dayRecords.map((r) => [r.id, r])), [dayRecords])

  const reachMetres = useMemo(() => {
    if (stationMode !== 'range') return null
    const from = parseStation(stationFrom)
    const to = parseStation(stationTo)
    if (from === null || to === null) return null
    return to - from
  }, [stationMode, stationFrom, stationTo])

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

  const isToday = workDate === todayLocalDateString()

  function resetFields() {
    setStationFrom('')
    setStationTo('')
    setQuantity('')
    setNote('')
    setLocation('')
    setFormError(null)
  }

  function openAdd() {
    setScreenMode('picker')
    setPickerSearch('')
    setItemId('')
    setCorrectingId(null)
    resetFields()
    requestAnimationFrame(() => pickerSearchRef.current?.focus())
  }

  function pickItemForAdd(item: Item) {
    setItemId(item.id)
    setCorrectingId(null)
    setStationMode('range')
    resetFields()
    setScreenMode('form')
    requestAnimationFrame(() => stationFromRef.current?.focus())
  }

  function closeToList() {
    setScreenMode('list')
    setItemId('')
    setCorrectingId(null)
    resetFields()
  }

  function startCorrection(record: QueuedQuantityRecord) {
    setCorrectingId(record.id)
    setWorkDate(record.workDate)
    setItemId(record.itemId)
    setStationMode(record.stationTo !== null ? 'range' : 'single')
    setStationFrom(record.stationFrom !== null ? String(record.stationFrom) : '')
    setStationTo(record.stationTo !== null ? String(record.stationTo) : '')
    setQuantity(String(record.quantity))
    setNote(record.note ?? '')
    setLocation(record.location ?? '')
    setFormError(null)
    setScreenMode('form')
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
      setFormError('Choose an Item.')
      return
    }
    // Defense in depth, not redundant with the picker: the picker already
    // excludes Lump Sum/Provisional Sum for a NEW entry (correctingId
    // null), but this re-checks at the point of the actual write. A
    // correction is exempted — it may legitimately target a historical
    // record against one of these kinds from before this screen existed.
    if (!correctingId && selectedItem !== undefined && !isUnitPriceItem(selectedItem)) {
      setFormError('Choose a Unit Price item — Lump Sum and Provisional Sum items are not recorded by quantity.')
      return
    }
    const qty = Number(quantity)
    if (quantity === '' || Number.isNaN(qty) || qty <= 0) {
      setFormError('Enter a quantity greater than zero.')
      return
    }
    const from = stationFrom === '' ? null : parseStation(stationFrom)
    if (stationFrom !== '' && from === null) {
      setFormError('Station From is not a valid station — try 12+400 or 12.400.')
      return
    }
    let to: number | null = null
    if (stationMode === 'range') {
      if (stationTo === '') {
        setFormError('Enter a Station To, or switch to single-station mode.')
        return
      }
      to = parseStation(stationTo)
      if (to === null) {
        setFormError('Station To is not a valid station — try 12+910 or 12.910.')
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
      // Fields reset, correction cleared, but the form stays open on the
      // same Item — a day's work is often several stations against the
      // same Item in a row.
      resetFields()
      setCorrectingId(null)
      stationFromRef.current?.focus()
    } catch (err) {
      setFormError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  // Same either/or as desktop: entering a new original needs enter_quantity,
  // saving a correction needs correct_quantity. A seat with only one of the
  // two still reaches the form; only the submit action is blocked.
  const formUsable = correctingId ? canCorrect : canEnter

  return (
    <div className="pb-24">
      {/* THE FOLD FIX — same reasoning as OwnerScreen's own sticky strip:
          the full three-line SandboxBanner pushed everything below it off
          a 375px screen's first scroll. Kept as one sticky cluster with the
          date signal below it so both stay on screen at every scroll
          position, including while the form is open, not only before it. */}
      <div className="sticky top-0 z-20">
        {contract.isSandbox && (
          <div className="flex items-center gap-2 bg-nc-danger-bg px-4 py-2 text-nc-danger-text">
            <IconAlertTriangle size={16} stroke={2} className="shrink-0" />
            <p className="text-label font-semibold uppercase tracking-wide">Sandbox — not a real contract, figures invented</p>
          </div>
        )}

        {/* The date signal — the priority on this surface, not the layout.
            Backfilling is routine here and least recoverable: a
            superintendent entering at day's end, on a phone, in the field.
            Neutral when today; an unmissable warning tone, not a subtle
            label, when it isn't — and sticky, so it stays visible through
            the whole entry flow. Two rows, not one crammed row: at 375px,
            [icon + date label + "not today" tag + date input] all on one
            line truncated the date label to nothing — the one thing this
            strip exists to show. The explanation gets its own full-width
            line instead of fighting the date input for space. */}
        <div className={isToday ? 'bg-nc-secondary' : 'bg-nc-warning-bg'}>
          <div className="flex items-center justify-between gap-2 px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              {!isToday && <IconAlertTriangle size={18} stroke={2} className="shrink-0 text-nc-warning-text" />}
              <span className={`truncate text-base font-bold ${isToday ? 'text-nc-text' : 'text-nc-warning-text'}`}>{isToday ? 'Today' : formatDayLabel(workDate)}</span>
            </div>
            {/* className="w-auto" alone isn't reliable here: Input's own
                base classes already include w-full, and which of the two
                wins depends on Tailwind's generated rule order, not on
                where each class appears in this attribute — on this
                screen's narrow width that let w-full win, squeezing the
                date label above to a truncated 0px. The inline style
                can't lose that fight. */}
            <Input type="date" className="shrink-0" style={{ width: 'auto' }} value={workDate} onChange={(e) => setWorkDate(e.target.value)} aria-label="Date" />
          </div>
          {!isToday && (
            <div className="flex items-center justify-between gap-2 px-4 pb-2.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-nc-warning-text">Not today — entries below are dated here</p>
              <Button type="button" variant="ghost" className="shrink-0 px-2 py-1 text-xs text-nc-warning-text" onClick={() => setWorkDate(todayLocalDateString())}>
                Back to today
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="px-4 pt-4">
        {!canEnter && !canCorrect ? (
          <EmptyState title="You don't have permission to enter or correct quantities on this contract." />
        ) : (
          <>
            {loadError && (
              <NotificationBanner tone="danger" className="mb-4">
                {loadError}
              </NotificationBanner>
            )}

            {screenMode === 'list' && (
              <>
                {chainageEntries.length > 0 && <ChainageStrip entries={chainageEntries} />}

                {dayRecords.length === 0 ? (
                  <EmptyState
                    icon={<IconCalendarPlus size={32} stroke={1.5} />}
                    title={isToday ? 'Nothing entered yet today.' : `Nothing entered for ${formatDayLabel(workDate)}.`}
                    description="Add the first record for this date."
                    action={
                      <Button type="button" onClick={openAdd}>
                        Add
                      </Button>
                    }
                  />
                ) : (
                  <div className="mt-4 flex flex-col gap-2">
                    {dayRecords.map((r) => {
                      const item = itemById.get(r.itemId)
                      const target = r.supersedes ? recordById.get(r.supersedes) : undefined
                      return (
                        <div key={r.id} className="rounded-lg border border-nc-border bg-white p-3 shadow-sm">
                          <div className="flex flex-wrap items-baseline gap-3">
                            <span className="font-semibold text-nc-text">{item?.itemNumber ?? r.itemId.slice(0, 8)}</span>
                            <span className="nc-numeric text-sm text-nc-text-muted">{fmtQuantity(r.quantity, item?.unit)}</span>
                            {r.stationFrom !== null && (
                              <span className="nc-numeric text-sm text-nc-text-muted">
                                {station(r.stationFrom)}
                                {r.stationTo !== null ? `–${station(r.stationTo)}` : ''}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            {r.location && <span className="text-xs text-nc-text-subtle">{r.location}</span>}
                            <StatusBadge status={r.status} />
                            {r.pending && <StatusBadge status="correcting">queued</StatusBadge>}
                            {supersededByConfirmed.has(r.id) && <StatusBadge status="superseded" />}
                          </div>
                          {target && (
                            <p className="mt-1 text-xs text-nc-info-text">
                              Corrects {fmtQuantity(target.quantity, item?.unit)} {target.status === 'confirmed' ? 'confirmed' : 'pending'} on {formatDayLabel(target.workDate)}
                            </p>
                          )}
                          <div className="mt-2 flex gap-2">
                            {r.status === 'draft' && r.pending === false && (
                              <Button type="button" variant="secondary" disabled={confirmingId === r.id || !contract.confirmQuantity} onClick={() => void handleConfirm(r.id)}>
                                {confirmingId === r.id ? 'Confirming…' : 'Confirm'}
                              </Button>
                            )}
                            <Button type="button" variant="secondary" disabled={!canCorrect} onClick={() => startCorrection(r)}>
                              Correct
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}

            {screenMode === 'picker' && (
              <div>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Choose an Item</p>
                  <Button type="button" variant="ghost" onClick={closeToList}>
                    Cancel
                  </Button>
                </div>
                <Input
                  ref={pickerSearchRef}
                  placeholder="Search by number or description…"
                  value={pickerSearch}
                  onChange={(e) => setPickerSearch(e.target.value)}
                  className="mb-3"
                  aria-label="Search Items"
                />
                <div className="flex flex-col divide-y divide-nc-border rounded-md border border-nc-border bg-white">
                  {filteredPickableItems.length === 0 ? (
                    <p className="p-3 text-sm text-nc-text-muted">No matching Items.</p>
                  ) : (
                    filteredPickableItems.map((item) => {
                      const last = progressByItemId.get(item.id)?.lastWorkDate ?? null
                      return (
                        <button key={item.id} type="button" onClick={() => pickItemForAdd(item)} className="flex w-full flex-col gap-0.5 px-3 py-3 text-left active:bg-nc-secondary">
                          <span className="font-semibold text-nc-text">
                            {item.itemNumber} <span className="font-normal text-nc-text-muted">{item.description}</span>
                          </span>
                          <span className="text-xs text-nc-text-muted">{last ? `Last recorded ${formatDayLabel(last)}` : 'Not yet recorded'}</span>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            )}

            {screenMode === 'form' && (
              <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm">
                    <span className="font-semibold text-nc-text">{selectedItem?.itemNumber}</span> <span className="text-nc-text-muted">{selectedItem?.description}</span>
                  </p>
                  <Button type="button" variant="ghost" onClick={closeToList}>
                    Done
                  </Button>
                </div>

                {correctingId && (
                  <NotificationBanner tone="info" className="flex items-center justify-between gap-3">
                    <span>Correcting a prior entry — the original stays in the total until this correction is confirmed.</span>
                    <Button type="button" variant="ghost" onClick={() => setCorrectingId(null)}>
                      Cancel
                    </Button>
                  </NotificationBanner>
                )}

                <div className="flex gap-2" role="group" aria-label="Station mode">
                  <Button type="button" variant={stationMode === 'single' ? 'primary' : 'secondary'} className="flex-1" onClick={() => setStationMode('single')} disabled={!formUsable}>
                    Single station
                  </Button>
                  <Button type="button" variant={stationMode === 'range' ? 'primary' : 'secondary'} className="flex-1" onClick={() => setStationMode('range')} disabled={!formUsable}>
                    From – To
                  </Button>
                </div>

                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="entry-station-from">
                      Station {stationMode === 'range' ? 'From' : ''}
                    </label>
                    <Input
                      id="entry-station-from"
                      ref={stationFromRef}
                      className="nc-numeric"
                      type="text"
                      inputMode="decimal"
                      placeholder="12+400"
                      value={stationFrom}
                      onChange={(e) => setStationFrom(e.target.value)}
                      disabled={!formUsable}
                    />
                  </div>
                  {stationMode === 'range' && (
                    <div className="flex-1">
                      <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="entry-station-to">
                        Station To
                      </label>
                      <Input
                        id="entry-station-to"
                        className="nc-numeric"
                        type="text"
                        inputMode="decimal"
                        placeholder="12+910"
                        value={stationTo}
                        onChange={(e) => setStationTo(e.target.value)}
                        disabled={!formUsable}
                      />
                    </div>
                  )}
                </div>
                {stationMode === 'range' && <p className="nc-numeric -mt-1 min-h-[1.2em] text-sm text-nc-accent">{reachMetres !== null ? `reach ${station(reachMetres)}` : ' '}</p>}

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
                  {selectedItem && selectedItem.itemKind === 'lump_sum' && <p className="mt-1 text-xs text-nc-text-muted">Lump-sum item — quantity is a % or portion complete, per contract convention.</p>}
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

                <Button type="submit" disabled={submitting || !formUsable} title={!formUsable ? `Needs permission to ${correctingId ? 'correct' : 'enter'} quantities` : undefined}>
                  {submitting ? 'Saving…' : !formUsable ? 'Not permitted' : correctingId ? 'Save correction' : 'Add entry'}
                </Button>
              </form>
            )}
          </>
        )}
      </div>

      {/* Fixed, thumb-reachable — bottom, not top, for one-handed portrait
          use. Only in list mode; picker/form have their own primary action
          already in view. */}
      {(canEnter || canCorrect) && screenMode === 'list' && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-nc-border bg-white p-3">
          <Button type="button" className="w-full" onClick={openAdd}>
            Add
          </Button>
        </div>
      )}
    </div>
  )
}
