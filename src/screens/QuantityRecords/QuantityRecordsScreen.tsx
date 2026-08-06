import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom'
import { IconCalendarPlus, IconCheck } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { useSession } from '../../lib/useSession'
import { fetchItems, isApplicationRateItem, isAreaUnit, isUnitPriceItem, type Item } from '../../lib/supabase/items'
import {
  confirmQuantityRecord,
  DIRECTIONS,
  fetchContractQuantityRecords,
  fetchDistinctLocations,
  pushQuantityRecord,
  StaleQuantityRecordError,
  updateQuantityRecordDraft,
  type Direction,
} from '../../lib/supabase/quantityRecords'
import { fetchItemMonths, fetchItemProgress, type ItemProgress } from '../../lib/supabase/monthlyPeriods'
import type { QueuedQuantityRecord } from '../../lib/db'
import { getDeviceId } from '../../lib/deviceId'
import { errorMessage } from '../../lib/errorMessage'
import { formatDayLabel, todayLocalDateString } from '../../lib/dateFormat'
import { parseStation, quantity as fmtQuantity, station } from '../../lib/format'
import { areaDifference, computeAreaFromWidth } from '../../lib/calculations/stretch'
import { Button, EmptyState, Input, NotificationBanner, PageHeader, SandboxBanner, Select, StatusBadge, Spinner } from '../../components/ui'

type DayRecord = Omit<QueuedQuantityRecord, 'pending' | 'lastError'>

const BLANK = {
  location: '',
  stationFrom: '',
  stationTo: '',
  quantity: '',
  note: '',
  direction: '' as Direction | '',
  lkiSegment: '',
  lkiVersion: '',
  averageWidth: '',
  area: '',
}

const LOCATIONS_LIST_ID = 'daily-entry-locations'

/**
 * Today's work, not the Item catalogue. The list below is scoped to the
 * selected date — a handful of rows on a busy day, none on a quiet one —
 * and the 41 (on Hwy 5) Unit Price Items only ever appear inside the Add
 * picker, never as 41 permanent rows most of which read "nothing yet."
 * Item history (every record against one Item, newest first, this period/
 * previous/to date/remaining) lives at Tracker -> Item detail; this screen
 * links to it rather than duplicating it.
 */
export function QuantityRecordsScreen() {
  const contract = useOutletContext<MyContract>()
  const canEnter = contract.enterQuantity
  const canCorrect = contract.correctQuantity
  const session = useSession()
  const userId = session?.user.id ?? null
  const navigate = useNavigate()

  const [workDate, setWorkDate] = useState(todayLocalDateString())
  const [items, setItems] = useState<Item[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [itemProgress, setItemProgress] = useState<ItemProgress[]>([])
  const [allRecords, setAllRecords] = useState<DayRecord[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  // The Add/Correct panel — panelOpen with formItem still null is the
  // search picker; setting formItem swaps the same panel over to the entry
  // form. Never opened by default (see the empty-state branch below) —
  // arriving on this screen, or landing on a quiet day, must show the day,
  // not force a choice before showing anything.
  const [panelOpen, setPanelOpen] = useState(false)
  const [formItem, setFormItem] = useState<Item | null>(null)
  const [pickerSearch, setPickerSearch] = useState('')
  const [correctingId, setCorrectingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [fields, setFields] = useState(BLANK)
  // See EntryScreen's own copy of this same flag for the full reasoning —
  // true once the person has typed into the area-ish field themselves (for
  // an Item whose own quantity IS area, that's the quantity field), or on
  // prefill for a correction/edit (an existing record's figure is already
  // the record of truth).
  const [areaFieldTouched, setAreaFieldTouched] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const stationFromRef = useRef<HTMLInputElement>(null)
  const pickerSearchRef = useRef<HTMLInputElement>(null)
  const [searchParams] = useSearchParams()
  const hasAppliedDeepLink = useRef(false)

  useEffect(() => {
    fetchItems(contract.id)
      .then(setItems)
      .catch((err: unknown) => setLoadError(errorMessage(err)))
    fetchDistinctLocations(contract.id)
      .then(setLocations)
      .catch(() => {
        /* autocomplete only — not worth surfacing as a page error */
      })
    // Drives the Add picker's recency sort only — a stale or failed fetch
    // still leaves a usable (just unsorted) picker, not a broken page.
    fetchItemProgress(contract.id)
      .then(setItemProgress)
      .catch(() => {
        console.warn('fetchItemProgress failed — Add picker will be unsorted')
      })
  }, [contract.id])

  function reload() {
    setStatus('loading')
    fetchContractQuantityRecords(contract.id)
      .then((rows) => {
        setAllRecords(rows)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }

  useEffect(reload, [contract.id])

  // After a submit/confirm — refreshes without dropping the open panel back
  // to a page-wide loading state.
  function refreshSilently() {
    fetchContractQuantityRecords(contract.id)
      .then(setAllRecords)
      .catch((err: unknown) => setLoadError(errorMessage(err)))
  }

  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const progressByItemId = useMemo(() => new Map(itemProgress.map((p) => [p.itemId, p])), [itemProgress])
  const recordById = useMemo(() => new Map(allRecords.map((r) => [r.id, r])), [allRecords])

  // Only Unit Price Items are enterable (GC 52.03 — Lump Sum/Provisional Sum
  // aren't recorded by quantity), sorted by recent activity on this
  // contract, not alphabetically — the same ordering the mobile Field Entry
  // picker already uses (fetchItemProgress's lastWorkDate), reused verbatim
  // rather than reinvented, including its own tie-break for never-recorded
  // Items. No manual pinning — recency tracks the work itself (milling one
  // week, paving the next) without anyone maintaining an order.
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

  // Today's work — every record dated to the selected day, any Item, oldest
  // first (the order they were actually entered in), same convention the
  // mobile screen's own day list already uses.
  const todaysRecords = useMemo(() => allRecords.filter((r) => r.workDate === workDate).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [allRecords, workDate])

  // Which Items already have a record on the SELECTED date — distinct from
  // progressByItemId's lastWorkDate (contract-wide, any date ever). Drives
  // the picker's "already done today" marker, so someone working down a
  // field sheet can see progress through it at a glance.
  const todaysItemIds = useMemo(() => new Set(todaysRecords.map((r) => r.itemId)), [todaysRecords])

  // A confirmed record that's been superseded by a CONFIRMED correction no
  // longer counts — "superseded" badge. Separate from pendingCorrectionByTarget
  // below, which is the still-open case: superseded by a DRAFT, so the
  // original still counts until that correction is itself confirmed.
  const supersededByConfirmed = useMemo(() => {
    const set = new Set<string>()
    for (const r of allRecords) if (r.supersedes && r.status === 'confirmed') set.add(r.supersedes)
    return set
  }, [allRecords])

  const pendingCorrectionByTarget = useMemo(() => {
    const map = new Map<string, DayRecord>()
    for (const r of allRecords) if (r.status === 'draft' && r.supersedes) map.set(r.supersedes, r)
    return map
  }, [allRecords])

  const isToday = workDate === todayLocalDateString()

  // Deep link from Tracker/Finance: ?itemId=&period= opens the panel
  // straight to that Item's entry form (skipping the picker — the URL
  // already states the intent) and, when a period is given, dates the
  // entry to the period's first working day. Waits for items to load.
  useEffect(() => {
    if (hasAppliedDeepLink.current || items.length === 0) return
    const deepLinkItemId = searchParams.get('itemId')
    const deepLinkPeriod = searchParams.get('period')
    if (!deepLinkItemId && !deepLinkPeriod) return
    hasAppliedDeepLink.current = true
    const targetItem = deepLinkItemId ? (items.find((i) => i.id === deepLinkItemId) ?? null) : null
    if (targetItem) {
      setPanelOpen(true)
      setFormItem(targetItem)
    }
    if (deepLinkItemId && deepLinkPeriod) {
      fetchItemMonths(contract.id)
        .then((months) => {
          const match = months.find((m) => m.itemId === deepLinkItemId && m.periodMonth === deepLinkPeriod)
          if (match) setWorkDate(match.firstWorkDate)
        })
        .catch(() => {
          /* deep link is a convenience — falls back to today's date, not a page error */
        })
    }
  }, [contract.id, searchParams, items])

  const reachMetres = useMemo(() => {
    const from = parseStation(fields.stationFrom)
    const to = parseStation(fields.stationTo)
    if (from === null || to === null) return null
    return to - from
  }, [fields.stationFrom, fields.stationTo])

  // Driven by items.area_basis (0038) — see EntryScreen's own copy of this
  // logic, and items.ts's isAreaUnit/isApplicationRateItem doc comments,
  // for the full reasoning.
  const areaUnit = formItem ? isAreaUnit(formItem) : false
  const applicationRate = formItem ? isApplicationRateItem(formItem) : false
  const showStretchFields = areaUnit || applicationRate

  const parsedStationFromForArea = useMemo(() => (fields.stationFrom === '' ? null : parseStation(fields.stationFrom)), [fields.stationFrom])
  const parsedStationToForArea = useMemo(() => (fields.stationTo === '' ? null : parseStation(fields.stationTo)), [fields.stationTo])
  const widthNum = fields.averageWidth === '' ? null : Number(fields.averageWidth)
  const computedArea = useMemo(
    () => computeAreaFromWidth(widthNum !== null && !Number.isNaN(widthNum) ? widthNum : null, parsedStationFromForArea, parsedStationToForArea),
    [widthNum, parsedStationFromForArea, parsedStationToForArea],
  )

  // The convenience-fill: while untouched, the area-ish field tracks
  // width x reach live; the instant the person types into it directly, this
  // stops — their figure is accepted as recorded, never silently
  // overwritten by a later width or station change.
  useEffect(() => {
    if (!showStretchFields || areaFieldTouched || computedArea === null) return
    const str = computedArea.toFixed(2)
    setFields((f) => (areaUnit ? { ...f, quantity: str } : { ...f, area: str }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computedArea, showStretchFields, areaFieldTouched, areaUnit])

  const enteredAreaIsh = areaUnit ? (fields.quantity === '' ? null : Number(fields.quantity)) : fields.area === '' ? null : Number(fields.area)
  const areaDiff = areaDifference(enteredAreaIsh !== null && !Number.isNaN(enteredAreaIsh) ? enteredAreaIsh : null, computedArea)

  function openAdd() {
    setPanelOpen(true)
    setFormItem(null)
    setCorrectingId(null)
    setEditingId(null)
    setFields(BLANK)
    setAreaFieldTouched(false)
    setFormError(null)
    setPickerSearch('')
    requestAnimationFrame(() => pickerSearchRef.current?.focus())
  }

  function pickItemForAdd(item: Item) {
    setFormItem(item)
    setFields(BLANK)
    setAreaFieldTouched(false)
    setCorrectingId(null)
    setEditingId(null)
    setFormError(null)
    requestAnimationFrame(() => stationFromRef.current?.focus())
  }

  function closePanel() {
    setPanelOpen(false)
    setFormItem(null)
    setCorrectingId(null)
    setEditingId(null)
    setFields(BLANK)
    setAreaFieldTouched(false)
    setFormError(null)
  }

  // A confirmed record can only be superseded — unchanged. Correcting always
  // creates a new row (supersedes = record.id).
  function startCorrection(record: DayRecord) {
    const item = itemById.get(record.itemId)
    if (!item) return
    setPanelOpen(true)
    setFormItem(item)
    setCorrectingId(record.id)
    setEditingId(null)
    setFields({
      location: record.location ?? '',
      stationFrom: record.stationFrom !== null ? String(record.stationFrom) : '',
      stationTo: record.stationTo !== null ? String(record.stationTo) : '',
      quantity: String(record.quantity),
      note: record.note ?? '',
      direction: record.direction ?? '',
      lkiSegment: record.lkiSegment !== null ? String(record.lkiSegment) : '',
      lkiVersion: record.lkiVersion !== null ? String(record.lkiVersion) : '',
      averageWidth: record.averageWidth !== null ? String(record.averageWidth) : '',
      area: record.area !== null ? String(record.area) : '',
    })
    // The record being corrected already has its own figure — never
    // silently recomputed just because a width and stations happen to be
    // present on it.
    setAreaFieldTouched(true)
    setFormError(null)
    requestAnimationFrame(() => stationFromRef.current?.focus())
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // 0021: a still-draft record is edited in place instead — nothing is
  // superseded, the row itself changes. Same prefill as a correction, but
  // submit updates the existing row rather than inserting a new one.
  function startEdit(record: DayRecord) {
    const item = itemById.get(record.itemId)
    if (!item) return
    setPanelOpen(true)
    setFormItem(item)
    setCorrectingId(null)
    setEditingId(record.id)
    setFields({
      location: record.location ?? '',
      stationFrom: record.stationFrom !== null ? String(record.stationFrom) : '',
      stationTo: record.stationTo !== null ? String(record.stationTo) : '',
      quantity: String(record.quantity),
      note: record.note ?? '',
      direction: record.direction ?? '',
      lkiSegment: record.lkiSegment !== null ? String(record.lkiSegment) : '',
      lkiVersion: record.lkiVersion !== null ? String(record.lkiVersion) : '',
      averageWidth: record.averageWidth !== null ? String(record.averageWidth) : '',
      area: record.area !== null ? String(record.area) : '',
    })
    setAreaFieldTouched(true)
    setFormError(null)
    requestAnimationFrame(() => stationFromRef.current?.focus())
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function handleConfirm(record: DayRecord) {
    setConfirmingId(record.id)
    setLoadError(null)
    try {
      await confirmQuantityRecord(record.id, record.version)
      refreshSilently()
    } catch (err) {
      // Refresh regardless of which error this was — a stale confirm means
      // this list is showing a version someone else has already changed,
      // and that has to be visible before it can be confirmed again.
      refreshSilently()
      if (err instanceof StaleQuantityRecordError) {
        setLoadError('This entry changed since the list loaded — showing the latest version now. Check it before confirming again.')
      } else {
        setLoadError(errorMessage(err))
      }
    } finally {
      setConfirmingId(null)
    }
  }

  async function doSubmit() {
    setFormError(null)
    if (!userId) {
      setFormError('Not signed in.')
      return
    }
    if (!formItem) {
      setFormError('Choose an Item.')
      return
    }
    // Defense in depth, not redundant with the picker: the picker already
    // excludes Lump Sum/Provisional Sum for a NEW entry (correctingId/
    // editingId null), but this re-checks at the point of the actual write.
    // A correction or an edit is exempted — startCorrection/startEdit always
    // resolve formItem from the record itself, which may legitimately be one
    // of these kinds from before this screen existed.
    if (!correctingId && !editingId && !isUnitPriceItem(formItem)) {
      setFormError('Choose a Unit Price item — Lump Sum and Provisional Sum items are not recorded by quantity.')
      return
    }
    const qty = Number(fields.quantity)
    if (fields.quantity === '' || Number.isNaN(qty) || qty <= 0) {
      setFormError('Enter a quantity greater than zero.')
      return
    }
    const from = fields.stationFrom === '' ? null : parseStation(fields.stationFrom)
    if (fields.stationFrom !== '' && from === null) {
      setFormError('Station From is not a valid station — try 12+400 or 12.400.')
      return
    }
    let to: number | null = null
    if (fields.stationTo !== '') {
      to = parseStation(fields.stationTo)
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
    const lkiSegmentNum = fields.lkiSegment === '' ? null : Number(fields.lkiSegment)
    if (fields.lkiSegment !== '' && (lkiSegmentNum === null || Number.isNaN(lkiSegmentNum) || lkiSegmentNum <= 0)) {
      setFormError('LKI segment is not a valid number.')
      return
    }
    const lkiVersionNum = fields.lkiVersion === '' ? null : Number(fields.lkiVersion)
    if (fields.lkiVersion !== '' && (lkiVersionNum === null || Number.isNaN(lkiVersionNum) || lkiVersionNum <= 0)) {
      setFormError('LKI version is not a valid number.')
      return
    }
    if (lkiVersionNum !== null && lkiSegmentNum === null) {
      setFormError('LKI version needs an LKI segment — a version means nothing without knowing which segment it versions.')
      return
    }
    const averageWidthNum = fields.averageWidth === '' ? null : Number(fields.averageWidth)
    if (fields.averageWidth !== '' && (averageWidthNum === null || Number.isNaN(averageWidthNum) || averageWidthNum < 0)) {
      setFormError('Average width is not a valid number.')
      return
    }
    // area is only ever a real, separate field for a non-Square-Metre
    // application-rate Item — for an area Item, the "area" figure IS
    // quantity (already validated above), and this stays null.
    const areaNum = !areaUnit && fields.area !== '' ? Number(fields.area) : null
    if (!areaUnit && fields.area !== '' && (areaNum === null || Number.isNaN(areaNum) || areaNum < 0)) {
      setFormError('Area is not a valid number.')
      return
    }

    setSubmitting(true)
    try {
      if (editingId) {
        // 0021: editing a draft in place — enter_quantity, not
        // correct_quantity, and no supersedes row is written. Closes the
        // panel rather than staying open: unlike Add, there's no "next
        // station" to keep entering against this one existing row.
        await updateQuantityRecordDraft(editingId, {
          workDate,
          location: fields.location.trim() || null,
          quantity: qty,
          note: fields.note.trim() || null,
          stationFrom: from,
          stationTo: to,
          direction: fields.direction === '' ? null : fields.direction,
          lkiSegment: lkiSegmentNum,
          lkiVersion: lkiVersionNum,
          averageWidth: averageWidthNum,
          area: areaNum,
        })
        closePanel()
        refreshSilently()
      } else {
        await pushQuantityRecord({
          id: crypto.randomUUID(),
          contractId: contract.id,
          itemId: formItem.id,
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
          direction: fields.direction === '' ? null : fields.direction,
          lkiSegment: lkiSegmentNum,
          lkiVersion: lkiVersionNum,
          averageWidth: averageWidthNum,
          area: areaNum,
          // Matches the server column's own default (0022) — pushQuantityRecord
          // doesn't send this to the server; the row's real version is read
          // back from the server response instead.
          version: 1,
        })
        // Panel and Item stay open — a day's work is often several stations
        // against the SAME Item in a row, and reopening the picker each
        // time would undo the whole point of inverting this screen. Only
        // the STRETCH-specific fields clear (stations, width, area,
        // quantity, note) — Location, Direction, and the LKI pair persist,
        // since consecutive stretches on one Item overwhelmingly share all
        // three (same crew, same lane, same segment, different chainage).
        // Explicit "Change item" is the deliberate reset; staying — location
        // included — is the default for everything else.
        setFields((f) => ({ ...BLANK, location: f.location, direction: f.direction, lkiSegment: f.lkiSegment, lkiVersion: f.lkiVersion }))
        setAreaFieldTouched(false)
        setCorrectingId(null)
        stationFromRef.current?.focus()
        refreshSilently()
      }
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

  function handleFormKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    void doSubmit()
  }

  // Editing a draft needs enter_quantity (0021); correcting a confirmed
  // record needs correct_quantity, unchanged.
  const formUsable = editingId ? canEnter : correctingId ? canCorrect : canEnter
  const subtitle = `Daily entry · ${contract.name}`

  return (
    <div>
      <PageHeader
        title={formatDayLabel(workDate)}
        subtitle={subtitle}
        actions={
          <div className="flex items-center gap-2">
            <Input type="date" className="w-auto" value={workDate} onChange={(e) => setWorkDate(e.target.value)} aria-label="Date" />
            <Button type="button" onClick={openAdd}>
              Add
            </Button>
          </div>
        }
      />

      {/* The date is load-bearing: absent because it's a fresh morning and
          absent because you're on the wrong date must not look alike. This
          banner is the difference — present only when backfilling, so its
          mere absence already tells you you're on today. */}
      {!isToday && (
        <NotificationBanner tone="warning" className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <span>Not today — new entries here are dated {formatDayLabel(workDate)}.</span>
          <Button type="button" variant="ghost" onClick={() => setWorkDate(todayLocalDateString())}>
            Back to today
          </Button>
        </NotificationBanner>
      )}

      {/* 'working' — a screen a crew re-enters all day, not read-once. */}
      <SandboxBanner contract={contract} variant="working" />

      {!canEnter && !canCorrect ? (
        <EmptyState title="You don't have permission to enter or correct quantities on this contract." />
      ) : (
        <>
          <datalist id={LOCATIONS_LIST_ID}>
            {locations.map((loc) => (
              <option key={loc} value={loc} />
            ))}
          </datalist>

          {status === 'loading' && (
            <div className="flex items-center gap-2 py-8 text-nc-text-muted">
              <Spinner />
              <span className="text-sm">Loading…</span>
            </div>
          )}
          {status === 'error' && loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}
          {status === 'ready' && loadError && (
            <NotificationBanner tone="danger" className="mb-4">
              {loadError}
            </NotificationBanner>
          )}

          {status === 'ready' && (
            <>
              {panelOpen && (
                <div className="mb-4 rounded-lg border border-nc-border bg-nc-secondary p-4">
                  {!formItem ? (
                    <>
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Choose an Item</p>
                        <Button type="button" variant="ghost" onClick={closePanel}>
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
                      <div className="max-h-72 overflow-y-auto rounded-md border border-nc-border bg-white">
                        {filteredPickableItems.length === 0 ? (
                          <p className="p-3 text-sm text-nc-text-muted">No matching Items.</p>
                        ) : (
                          filteredPickableItems.map((item) => {
                            // lastWorkDate is contract-wide (any date, ever)
                            // — deliberately worded "Never recorded" rather
                            // than "Not yet recorded" so it can't be misread
                            // as "not done today" on a contract an Item has
                            // been worked on for weeks. Recorded-today is a
                            // separate, date-scoped check (todaysItemIds).
                            const last = progressByItemId.get(item.id)?.lastWorkDate ?? null
                            const recordedToday = todaysItemIds.has(item.id)
                            return (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => pickItemForAdd(item)}
                                className="flex w-full items-center justify-between gap-3 border-b border-nc-border px-3 py-2 text-left last:border-0 hover:bg-nc-secondary"
                              >
                                <span className="min-w-0 truncate">
                                  <span className="nc-numeric font-semibold text-nc-text">{item.itemNumber}</span>{' '}
                                  <span className="text-sm text-nc-text-muted">{item.description}</span>
                                </span>
                                {recordedToday ? (
                                  <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-nc-success-text">
                                    <IconCheck size={14} stroke={2.5} /> {isToday ? 'Recorded today' : `Recorded ${formatDayLabel(workDate)}`}
                                  </span>
                                ) : (
                                  <span className="shrink-0 text-xs text-nc-text-muted">{last ? `Last ${formatDayLabel(last)}` : 'Never recorded'}</span>
                                )}
                              </button>
                            )
                          })
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm">
                          <span className="nc-numeric font-semibold text-nc-text">{formItem.itemNumber}</span> <span className="text-nc-text-muted">{formItem.description}</span>
                        </p>
                        <div className="flex items-center gap-2">
                          {!correctingId && !editingId && (
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => {
                                setFormItem(null)
                                setPickerSearch('')
                                requestAnimationFrame(() => pickerSearchRef.current?.focus())
                              }}
                            >
                              Change item
                            </Button>
                          )}
                          <Button type="button" variant="ghost" onClick={closePanel}>
                            Close
                          </Button>
                        </div>
                      </div>

                      {correctingId && (
                        <NotificationBanner tone="info" className="mb-3 flex flex-wrap items-center justify-between gap-3">
                          <span>Correcting a prior entry — the original stays in the total until this correction is confirmed.</span>
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => {
                              setCorrectingId(null)
                              setFields(BLANK)
                              setAreaFieldTouched(false)
                            }}
                          >
                            Cancel correction
                          </Button>
                        </NotificationBanner>
                      )}

                      {editingId && (
                        <NotificationBanner tone="info" className="mb-3 flex flex-wrap items-center justify-between gap-3">
                          <span>Editing this entry directly — nothing is added, and it isn't recorded as a correction.</span>
                          <Button type="button" variant="ghost" onClick={closePanel}>
                            Cancel
                          </Button>
                        </NotificationBanner>
                      )}

                      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
                        <div className="min-w-[180px] flex-1">
                          <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="de-location">
                            Location
                          </label>
                          <Input
                            id="de-location"
                            list={LOCATIONS_LIST_ID}
                            value={fields.location}
                            onChange={(e) => setFields({ ...fields, location: e.target.value })}
                            onKeyDown={handleFormKeyDown}
                            disabled={!formUsable}
                          />
                        </div>
                        <div className="w-24">
                          <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="de-direction">
                            Direction
                          </label>
                          <Select
                            id="de-direction"
                            value={fields.direction}
                            onChange={(e) => setFields({ ...fields, direction: e.target.value as Direction | '' })}
                            disabled={!formUsable}
                          >
                            <option value="">—</option>
                            {DIRECTIONS.map((d) => (
                              <option key={d} value={d}>
                                {d}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <div className="w-24">
                          <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="de-lki-segment">
                            LKI segment
                          </label>
                          <Input
                            id="de-lki-segment"
                            className="nc-numeric"
                            type="text"
                            inputMode="numeric"
                            placeholder="2090"
                            value={fields.lkiSegment}
                            onChange={(e) => setFields({ ...fields, lkiSegment: e.target.value })}
                            onKeyDown={handleFormKeyDown}
                            disabled={!formUsable}
                          />
                        </div>
                        <div className="w-24">
                          <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="de-lki-version">
                            LKI version
                          </label>
                          <Input
                            id="de-lki-version"
                            className="nc-numeric"
                            type="text"
                            inputMode="numeric"
                            placeholder="1"
                            value={fields.lkiVersion}
                            onChange={(e) => setFields({ ...fields, lkiVersion: e.target.value })}
                            onKeyDown={handleFormKeyDown}
                            disabled={!formUsable}
                          />
                        </div>
                        {/* Point-located work (Inspect Manholes, Asphalt
                            Spillways — several discrete stations recorded
                            under one Item on one date) is one record per
                            point, Station To left blank, not a point list on
                            a single record. quantity_records is already
                            append-only with per-row confirmation; a bundled
                            record would force confirming or correcting every
                            point together even when only one needed it, and
                            the real examples show points that genuinely
                            diverge in fate (one manhole adjusted, another
                            replaced) — only representable if each point is
                            its own row, with Location/Note carrying that
                            point's own text. No schema change either way:
                            station_to is already nullable. The above-BLANK
                            persistence (Location/Direction/LKI survive an
                            Add, only station/width/area/quantity/note clear)
                            is what makes typing six of these fast — type the
                            station, Enter, type the next, Enter. */}
                        <div className="w-28">
                          <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="de-station-from">
                            Station from
                          </label>
                          <Input
                            id="de-station-from"
                            ref={stationFromRef}
                            className="nc-numeric"
                            type="text"
                            inputMode="decimal"
                            placeholder="12+400"
                            value={fields.stationFrom}
                            onChange={(e) => setFields({ ...fields, stationFrom: e.target.value })}
                            onKeyDown={handleFormKeyDown}
                            disabled={!formUsable}
                          />
                        </div>
                        <div className="w-28">
                          <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="de-station-to">
                            Station to
                          </label>
                          <Input
                            id="de-station-to"
                            className="nc-numeric"
                            type="text"
                            inputMode="decimal"
                            placeholder="12+910"
                            value={fields.stationTo}
                            onChange={(e) => setFields({ ...fields, stationTo: e.target.value })}
                            onKeyDown={handleFormKeyDown}
                            disabled={!formUsable}
                          />
                        </div>
                        <div className="w-20">
                          <p className="mb-1 text-xs text-nc-text-muted">Reach</p>
                          <p className="nc-numeric px-3 py-2 text-sm text-nc-text-muted">{reachMetres !== null ? station(reachMetres) : '—'}</p>
                        </div>
                        {showStretchFields && (
                          <div className="w-28">
                            <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="de-average-width">
                              Avg width (m)
                            </label>
                            <Input
                              id="de-average-width"
                              className="nc-numeric"
                              type="text"
                              inputMode="decimal"
                              placeholder="5.50"
                              value={fields.averageWidth}
                              onChange={(e) => setFields({ ...fields, averageWidth: e.target.value })}
                              onKeyDown={handleFormKeyDown}
                              disabled={!formUsable}
                            />
                          </div>
                        )}
                        {applicationRate && (
                          <div className="w-28">
                            <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="de-area">
                              Area (m²)
                            </label>
                            <Input
                              id="de-area"
                              className="nc-numeric"
                              type="text"
                              inputMode="decimal"
                              value={fields.area}
                              onChange={(e) => {
                                setAreaFieldTouched(true)
                                setFields({ ...fields, area: e.target.value })
                              }}
                              onKeyDown={handleFormKeyDown}
                              disabled={!formUsable}
                            />
                          </div>
                        )}
                        <div className="w-28">
                          <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="de-quantity">
                            Quantity{formItem ? ` (${formItem.unit})` : ''}
                          </label>
                          <Input
                            id="de-quantity"
                            className="nc-numeric"
                            type="number"
                            step="0.01"
                            value={fields.quantity}
                            onChange={(e) => {
                              if (areaUnit) setAreaFieldTouched(true)
                              setFields({ ...fields, quantity: e.target.value })
                            }}
                            onKeyDown={handleFormKeyDown}
                            disabled={!formUsable}
                          />
                          {areaUnit && <p className="mt-1 w-40 text-xs text-nc-text-subtle">This Item's quantity is its area.</p>}
                        </div>
                        {showStretchFields && areaDiff !== null && areaDiff !== 0 && (
                          // Never an alarm tone — a difference here can
                          // legitimately mean the field sheet's own measured
                          // figure, which supersedes the calculation by
                          // standing rule on this contract, not an error.
                          <p className="w-full text-xs text-nc-text-muted">
                            {areaUnit ? 'Quantity' : 'Area'} is {fmtQuantity(Math.abs(areaDiff))} m² {areaDiff > 0 ? 'more' : 'less'} than width × reach ({fmtQuantity(computedArea)} m²).
                          </p>
                        )}
                        <div className="min-w-[200px] flex-1">
                          <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="de-note">
                            Note
                          </label>
                          <Input id="de-note" value={fields.note} onChange={(e) => setFields({ ...fields, note: e.target.value })} onKeyDown={handleFormKeyDown} disabled={!formUsable} />
                        </div>
                        <Button
                          type="submit"
                          disabled={submitting || !formUsable}
                          title={!formUsable ? `Needs permission to ${editingId ? 'enter' : correctingId ? 'correct' : 'enter'} quantities` : undefined}
                        >
                          {submitting ? 'Saving…' : !formUsable ? 'Not permitted' : editingId ? 'Save changes' : correctingId ? 'Save correction' : 'Add — Enter'}
                        </Button>
                      </form>
                      {formError && (
                        <NotificationBanner tone="danger" className="mt-3">
                          {formError}
                        </NotificationBanner>
                      )}
                    </>
                  )}
                </div>
              )}

              {todaysRecords.length > 0 ? (
                <div className="space-y-2">
                  {todaysRecords.map((r) => {
                    const item = itemById.get(r.itemId)
                    const target = r.supersedes ? recordById.get(r.supersedes) : undefined
                    const pendingCorrection = r.status === 'confirmed' ? pendingCorrectionByTarget.get(r.id) : undefined
                    const sameDayPending = pendingCorrection !== undefined && pendingCorrection.workDate === r.workDate
                    return (
                      <div key={r.id} className="rounded-lg border border-nc-border bg-white p-3 shadow-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0 text-sm text-nc-text">
                            <span className="nc-numeric font-semibold">{item?.itemNumber ?? r.itemId.slice(0, 8)}</span> <span className="text-nc-text-muted">{item?.description}</span>
                            <span className="nc-numeric"> · {fmtQuantity(r.quantity, item?.unit)}</span>
                            {r.stationFrom !== null && (
                              <span className="nc-numeric text-nc-text-muted">
                                {' '}
                                · {station(r.stationFrom)}
                                {r.stationTo !== null ? `–${station(r.stationTo)}` : ''}
                              </span>
                            )}
                            {r.location && <span className="text-nc-text-muted"> · {r.location}</span>}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <StatusBadge status={r.status} />
                            {supersededByConfirmed.has(r.id) && <StatusBadge status="superseded" />}
                          </div>
                        </div>
                        {r.note && <p className="mt-1 text-xs text-nc-text-muted">{r.note}</p>}
                        {target && (
                          <p className="mt-1 text-xs text-nc-info-text">
                            Corrects {fmtQuantity(target.quantity, item?.unit)} {target.status === 'confirmed' ? 'confirmed' : 'pending'} on {formatDayLabel(target.workDate)}
                          </p>
                        )}
                        {pendingCorrection && (
                          <p className="mt-1 text-xs text-nc-info-text">
                            {sameDayPending
                              ? 'A correction above is pending confirmation — this figure still counts until then.'
                              : `A correction dated ${formatDayLabel(pendingCorrection.workDate)} is pending confirmation — this figure still counts until then.`}
                          </p>
                        )}
                        <div className="mt-2 flex items-center gap-2">
                          {r.status === 'draft' && (
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={confirmingId === r.id || !contract.confirmQuantity}
                              title={!contract.confirmQuantity ? 'Needs permission to confirm quantity records' : undefined}
                              onClick={() => void handleConfirm(r)}
                            >
                              {confirmingId === r.id ? 'Confirming…' : 'Confirm'}
                            </Button>
                          )}
                          {r.status === 'draft' ? (
                            // 0021: a draft is edited in place, not corrected.
                            <Button type="button" variant="secondary" disabled={!canEnter} title={!canEnter ? 'Needs permission to enter quantities' : undefined} onClick={() => startEdit(r)}>
                              Edit
                            </Button>
                          ) : (
                            <Button type="button" variant="secondary" disabled={!canCorrect} title={!canCorrect ? 'Needs permission to correct quantity records' : undefined} onClick={() => startCorrection(r)}>
                              Correct
                            </Button>
                          )}
                          {/* History lives at Tracker -> Item detail — every
                              record against this Item, newest first, with
                              this period/previous/to date/remaining. Link
                              to it, don't rebuild it here. */}
                          <Button type="button" variant="ghost" onClick={() => navigate(`/tracker/${r.itemId}`)}>
                            History
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                !panelOpen && (
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
                )
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
