import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconAlertTriangle, IconCalendarPlus } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { useSession } from '../../lib/useSession'
import { useLiveQuery } from '../../lib/sync/useLiveQuery'
import { db, type QueuedQuantityRecord } from '../../lib/db'
import { enqueueQuantityRecord, importServerQuantityRecords, registerSyncListeners, syncQueuedQuantityRecords } from '../../lib/sync/quantityRecordsSync'
import {
  confirmQuantityRecord,
  DIRECTIONS,
  fetchDistinctLocations,
  fetchQuantityRecordsForDate,
  StaleQuantityRecordError,
  updateQuantityRecordDraft,
  type Direction,
} from '../../lib/supabase/quantityRecords'
import { fetchItems, isApplicationRateItem, isAreaUnit, isUnitPriceItem, type Item } from '../../lib/supabase/items'
import { fetchDerivationRules, type DerivationRule } from '../../lib/supabase/derivationRules'
import { fetchItemProgressRate, type ItemProgressRate } from '../../lib/supabase/monthlyPeriods'
import { getDeviceId } from '../../lib/deviceId'
import { errorMessage } from '../../lib/errorMessage'
import { formatDayLabel, todayLocalDateString } from '../../lib/dateFormat'
import { areaDifference, computeAreaFromWidth } from '../../lib/calculations/stretch'
import { deriveQuantity } from '../../lib/calculations/derivation'
import { ChainageStrip, type ChainageEntry } from '../../components/ChainageStrip'
import { Button, EmptyState, Input, NotificationBanner, Select, StatusBadge, Textarea } from '../../components/ui'
import { quantity as fmtQuantity, parseStation, station } from '../../lib/format'

type StationMode = 'single' | 'range'
type ScreenMode = 'list' | 'picker' | 'form'

/**
 * Today's work, not the form. The same inversion as desktop Daily Entry,
 * for the same reason: a permanently-open seven-field form docked above
 * the day's list buries the one thing that matters (what's been entered
 * today) on the screen where vertical space is scarcest. The list leads;
 * Add is a single action that opens a recency-sorted, searchable picker
 * (fetchItemProgressRate's ordering, the same one this screen already used
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
  const [itemProgress, setItemProgress] = useState<ItemProgressRate[]>([])
  const [rules, setRules] = useState<DerivationRule[]>([])
  const [derivationSourceRecords, setDerivationSourceRecords] = useState<Omit<QueuedQuantityRecord, 'pending' | 'lastError'>[]>([])
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
  const [direction, setDirection] = useState<Direction | ''>('')
  const [lkiSegment, setLkiSegment] = useState('')
  const [lkiVersion, setLkiVersion] = useState('')
  const [averageWidth, setAverageWidth] = useState('')
  const [area, setArea] = useState('')
  // True once the person has typed into the area-ish field themselves (for
  // an Item whose own quantity IS area, that's the quantity field; the
  // convenience-fill below stops touching it the instant they have — see
  // the effect after computedArea. Also set on prefill (startEdit/
  // startCorrection): an existing record's own figure is already the record
  // of truth and must never be silently recomputed out from under it.
  const [areaFieldTouched, setAreaFieldTouched] = useState(false)
  const [derivedQuantityTouched, setDerivedQuantityTouched] = useState(false)
  const [correctingId, setCorrectingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
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
    fetchItemProgressRate(contract.id)
      .then((rows) => setItemProgress(rows))
      .catch((err: unknown) => {
        console.warn('fetchItemProgressRate failed (likely offline) — item picker will be unsorted:', err)
      })
    // Drives the derived-quantity convenience-fill only.
    fetchDerivationRules(contract.id)
      .then(setRules)
      .catch((err: unknown) => console.warn('fetchDerivationRules failed:', err))
  }, [contract.id])

  const dayRecords = useLiveQuery(
    () => db.quantityRecords.where('contractId').equals(contract.id).and((r) => r.workDate === workDate).sortBy('createdAt'),
    [contract.id, workDate],
    [] as QueuedQuantityRecord[],
  )

  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const selectedItem = itemById.get(itemId)

  // Driven by items.area_basis (0038), not unit/item-number string matching
  // — see items.ts's own isAreaUnit/isApplicationRateItem doc comments. A
  // quantity_is_area Item's own quantity IS its area — the width-derived-
  // area convenience-fill and disagreement check apply to QUANTITY directly
  // for these, never a second, separately-stored area figure.
  // separately_measured Items (paving lifts, shouldering, constructed base)
  // get their own area input instead. not_applicable and unclassified
  // (areaBasis === null) Items get neither — no width/area input renders.
  const areaUnit = selectedItem ? isAreaUnit(selectedItem) : false
  const applicationRate = selectedItem ? isApplicationRateItem(selectedItem) : false
  const showStretchFields = areaUnit || applicationRate

  const parsedStationFromForArea = useMemo(() => (stationFrom === '' ? null : parseStation(stationFrom)), [stationFrom])
  const parsedStationToForArea = useMemo(() => (stationMode === 'range' && stationTo !== '' ? parseStation(stationTo) : null), [stationMode, stationTo])
  const widthNum = averageWidth === '' ? null : Number(averageWidth)
  const computedArea = useMemo(
    () => computeAreaFromWidth(widthNum !== null && !Number.isNaN(widthNum) ? widthNum : null, parsedStationFromForArea, parsedStationToForArea),
    [widthNum, parsedStationFromForArea, parsedStationToForArea],
  )

  // The convenience-fill: while untouched, the area-ish field tracks
  // width × reach live. The instant the person types into it directly
  // (areaFieldTouched), this stops — their figure is accepted as recorded,
  // never silently overwritten by a later width or station change.
  useEffect(() => {
    if (!showStretchFields || areaFieldTouched || computedArea === null) return
    const str = computedArea.toFixed(2)
    if (areaUnit) setQuantity(str)
    else setArea(str)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computedArea, showStretchFields, areaFieldTouched, areaUnit])

  const enteredAreaIsh = areaUnit ? (quantity === '' ? null : Number(quantity)) : area === '' ? null : Number(area)
  const areaDiff = areaDifference(enteredAreaIsh !== null && !Number.isNaN(enteredAreaIsh) ? enteredAreaIsh : null, computedArea)

  // Derivation (0039) — same reasoning and behaviour as desktop Daily
  // Entry's own copy of this logic. Reads server data on demand, not the
  // local offline queue: a derivation sums OTHER Items' same-date records,
  // which may have been entered by a different crew member on a different
  // device, and the local queue only ever holds what THIS device has
  // seen. Offline, this simply proposes nothing — the person still enters
  // the figure directly, exactly as before this brief.
  const ruleByItemId = useMemo(() => new Map(rules.map((r) => [r.itemId, r])), [rules])
  const areaBasisByItemId = useMemo(() => new Map(items.map((i) => [i.id, i.areaBasis])), [items])
  const derivationRule = selectedItem ? ruleByItemId.get(selectedItem.id) : undefined

  useEffect(() => {
    if (!derivationRule) {
      setDerivationSourceRecords([])
      return
    }
    let cancelled = false
    fetchQuantityRecordsForDate(contract.id, workDate)
      .then((rows) => {
        if (!cancelled) setDerivationSourceRecords(rows)
      })
      .catch((err: unknown) => {
        if (!cancelled) setDerivationSourceRecords([])
        console.warn('fetchQuantityRecordsForDate failed (likely offline) — no derivation proposal:', err)
      })
    return () => {
      cancelled = true
    }
  }, [contract.id, workDate, derivationRule])

  const derivationSupersededByConfirmed = useMemo(() => {
    const set = new Set<string>()
    for (const r of derivationSourceRecords) if (r.supersedes && r.status === 'confirmed') set.add(r.supersedes)
    return set
  }, [derivationSourceRecords])

  const derivedProposal = useMemo(() => {
    if (!derivationRule) return null
    const sourceIds = new Set(derivationRule.sourceItemIds)
    const relevant = derivationSourceRecords
      .filter((r) => sourceIds.has(r.itemId) && !derivationSupersededByConfirmed.has(r.id))
      .map((r) => ({ itemId: r.itemId, quantity: r.quantity, area: r.area, stationFrom: r.stationFrom, stationTo: r.stationTo }))
    return deriveQuantity(derivationRule, areaBasisByItemId, relevant)
  }, [derivationRule, derivationSourceRecords, derivationSupersededByConfirmed, areaBasisByItemId])

  useEffect(() => {
    if (!derivationRule || derivedQuantityTouched || derivedProposal === null) return
    setQuantity(derivedProposal.toFixed(2))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedProposal, derivationRule, derivedQuantityTouched])

  const enteredQuantityForDerivation = quantity === '' ? null : Number(quantity)
  const derivationDiff = derivationRule
    ? areaDifference(enteredQuantityForDerivation !== null && !Number.isNaN(enteredQuantityForDerivation) ? enteredQuantityForDerivation : null, derivedProposal)
    : null

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
    setDirection('')
    setLkiSegment('')
    setLkiVersion('')
    setAverageWidth('')
    setArea('')
    setAreaFieldTouched(false)
    setDerivedQuantityTouched(false)
    setFormError(null)
  }

  function openAdd() {
    setScreenMode('picker')
    setPickerSearch('')
    setItemId('')
    setCorrectingId(null)
    setEditingId(null)
    resetFields()
    requestAnimationFrame(() => pickerSearchRef.current?.focus())
  }

  function pickItemForAdd(item: Item) {
    setItemId(item.id)
    setCorrectingId(null)
    setEditingId(null)
    setStationMode('range')
    resetFields()
    setScreenMode('form')
    requestAnimationFrame(() => stationFromRef.current?.focus())
  }

  function closeToList() {
    setScreenMode('list')
    setItemId('')
    setCorrectingId(null)
    setEditingId(null)
    resetFields()
  }

  // A confirmed record can only be superseded — unchanged. Correcting always
  // creates a new row (supersedes = record.id).
  function startCorrection(record: QueuedQuantityRecord) {
    setCorrectingId(record.id)
    setEditingId(null)
    setWorkDate(record.workDate)
    setItemId(record.itemId)
    setStationMode(record.stationTo !== null ? 'range' : 'single')
    setStationFrom(record.stationFrom !== null ? String(record.stationFrom) : '')
    setStationTo(record.stationTo !== null ? String(record.stationTo) : '')
    setQuantity(String(record.quantity))
    setNote(record.note ?? '')
    setLocation(record.location ?? '')
    setDirection(record.direction ?? '')
    setLkiSegment(record.lkiSegment !== null ? String(record.lkiSegment) : '')
    setLkiVersion(record.lkiVersion !== null ? String(record.lkiVersion) : '')
    setAverageWidth(record.averageWidth !== null ? String(record.averageWidth) : '')
    setArea(record.area !== null ? String(record.area) : '')
    // The record being corrected already has its own figure — never
    // silently recomputed just because a width and stations happen to be
    // present on it.
    setAreaFieldTouched(true)
    setDerivedQuantityTouched(true)
    setFormError(null)
    setScreenMode('form')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // 0021: a still-draft record is edited in place instead — nothing is
  // superseded, the row itself changes. Same prefill as a correction, but
  // submit updates the existing row rather than inserting a new one.
  function startEdit(record: QueuedQuantityRecord) {
    setEditingId(record.id)
    setCorrectingId(null)
    setWorkDate(record.workDate)
    setItemId(record.itemId)
    setStationMode(record.stationTo !== null ? 'range' : 'single')
    setStationFrom(record.stationFrom !== null ? String(record.stationFrom) : '')
    setStationTo(record.stationTo !== null ? String(record.stationTo) : '')
    setQuantity(String(record.quantity))
    setNote(record.note ?? '')
    setLocation(record.location ?? '')
    setDirection(record.direction ?? '')
    setLkiSegment(record.lkiSegment !== null ? String(record.lkiSegment) : '')
    setLkiVersion(record.lkiVersion !== null ? String(record.lkiVersion) : '')
    setAverageWidth(record.averageWidth !== null ? String(record.averageWidth) : '')
    setArea(record.area !== null ? String(record.area) : '')
    setAreaFieldTouched(true)
    setDerivedQuantityTouched(true)
    setFormError(null)
    setScreenMode('form')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function handleConfirm(record: QueuedQuantityRecord) {
    setConfirmingId(record.id)
    setLoadError(null)
    try {
      await confirmQuantityRecord(record.id, record.version)
      await importServerQuantityRecords(contract.id)
    } catch (err) {
      // Re-pull regardless of which error this was: a stale confirm means
      // someone else's edit is sitting on the server that this device
      // hasn't seen yet, and the record must show the version that was
      // actually rejected before it can be confirmed again — not the one
      // still on screen.
      await importServerQuantityRecords(contract.id).catch(() => {
        /* best-effort refresh — the error below still reaches the user either way */
      })
      if (err instanceof StaleQuantityRecordError) {
        setLoadError('This entry changed since the list loaded — showing the latest version now. Check it before confirming again.')
      } else {
        setLoadError(errorMessage(err))
      }
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
    // excludes Lump Sum/Provisional Sum for a NEW entry (correctingId/
    // editingId null), but this re-checks at the point of the actual write.
    // A correction or an edit is exempted — both may legitimately target a
    // historical record against one of these kinds from before this screen
    // existed.
    if (!correctingId && !editingId && selectedItem !== undefined && !isUnitPriceItem(selectedItem)) {
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
    const lkiSegmentNum = lkiSegment === '' ? null : Number(lkiSegment)
    if (lkiSegment !== '' && (lkiSegmentNum === null || Number.isNaN(lkiSegmentNum) || lkiSegmentNum <= 0)) {
      setFormError('LKI segment is not a valid number.')
      return
    }
    const lkiVersionNum = lkiVersion === '' ? null : Number(lkiVersion)
    if (lkiVersion !== '' && (lkiVersionNum === null || Number.isNaN(lkiVersionNum) || lkiVersionNum <= 0)) {
      setFormError('LKI version is not a valid number.')
      return
    }
    if (lkiVersionNum !== null && lkiSegmentNum === null) {
      setFormError('LKI version needs an LKI segment — a version means nothing without knowing which segment it versions.')
      return
    }
    const averageWidthNum = averageWidth === '' ? null : Number(averageWidth)
    if (averageWidth !== '' && (averageWidthNum === null || Number.isNaN(averageWidthNum) || averageWidthNum < 0)) {
      setFormError('Average width is not a valid number.')
      return
    }
    // area is only ever a real, separate field for a non-Square-Metre
    // application-rate Item — for an area Item, the "area" figure IS
    // quantity (already validated above), and this stays null.
    const areaNum = !areaUnit && area !== '' ? Number(area) : null
    if (!areaUnit && area !== '' && (areaNum === null || Number.isNaN(areaNum) || areaNum < 0)) {
      setFormError('Area is not a valid number.')
      return
    }

    setSubmitting(true)
    try {
      if (editingId) {
        // 0021: editing a draft in place — enter_quantity, not
        // correct_quantity, and no supersedes row is written. Returns to
        // the list rather than staying open: unlike Add, there's no "next
        // station" to keep entering against this one existing row.
        await updateQuantityRecordDraft(editingId, {
          workDate,
          location: location.trim() || null,
          quantity: qty,
          note: note.trim() || null,
          stationFrom: from,
          stationTo: to,
          direction: direction === '' ? null : direction,
          lkiSegment: lkiSegmentNum,
          lkiVersion: lkiVersionNum,
          averageWidth: averageWidthNum,
          area: areaNum,
        })
        await importServerQuantityRecords(contract.id)
        closeToList()
      } else {
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
          direction: direction === '' ? null : direction,
          lkiSegment: lkiSegmentNum,
          lkiVersion: lkiVersionNum,
          averageWidth: averageWidthNum,
          area: areaNum,
        })
        // Fields reset, correction cleared, but the form stays open on the
        // same Item — a day's work is often several stations against the
        // same Item in a row.
        resetFields()
        setCorrectingId(null)
        stationFromRef.current?.focus()
      }
    } catch (err) {
      setFormError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  // Editing a draft needs enter_quantity (0021); correcting a confirmed
  // record needs correct_quantity, unchanged. A seat with only one of the
  // two still reaches the form; only the submit action is blocked.
  const formUsable = editingId ? canEnter : correctingId ? canCorrect : canEnter

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
              <p className="text-xs font-semibold uppercase tracking-wide text-nc-warning-text">Not today — you're entering work for {formatDayLabel(workDate)}</p>
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
                            {r.status === 'draft' ? (
                              <>
                                {r.pending === false && (
                                  <Button type="button" variant="secondary" disabled={confirmingId === r.id || !contract.confirmQuantity} onClick={() => void handleConfirm(r)}>
                                    {confirmingId === r.id ? 'Confirming…' : 'Confirm'}
                                  </Button>
                                )}
                                {/* 0021: a draft is edited in place, not corrected —
                                    only reachable once synced (edits go straight to
                                    the server, same precondition Confirm already has). */}
                                <Button
                                  type="button"
                                  variant="secondary"
                                  disabled={!canEnter || r.pending}
                                  title={r.pending ? 'Still syncing — try again once this entry has synced' : !canEnter ? 'Needs permission to enter quantities' : undefined}
                                  onClick={() => startEdit(r)}
                                >
                                  Edit
                                </Button>
                              </>
                            ) : (
                              <Button type="button" variant="secondary" disabled={!canCorrect} onClick={() => startCorrection(r)}>
                                Correct
                              </Button>
                            )}
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

                {editingId && (
                  <NotificationBanner tone="info" className="flex items-center justify-between gap-3">
                    <span>Editing this entry directly — nothing is added, and it isn't recorded as a correction.</span>
                    <Button type="button" variant="ghost" onClick={closeToList}>
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
                    <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="entry-direction">
                      Direction
                    </label>
                    <Select id="entry-direction" value={direction} onChange={(e) => setDirection(e.target.value as Direction | '')} disabled={!formUsable}>
                      <option value="">—</option>
                      {DIRECTIONS.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex-1">
                    <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="entry-lki-segment">
                      LKI segment
                    </label>
                    <Input
                      id="entry-lki-segment"
                      className="nc-numeric"
                      type="text"
                      inputMode="numeric"
                      placeholder="2090"
                      value={lkiSegment}
                      onChange={(e) => setLkiSegment(e.target.value)}
                      disabled={!formUsable}
                    />
                  </div>
                  <div className="flex-1">
                    <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="entry-lki-version">
                      LKI version
                    </label>
                    <Input
                      id="entry-lki-version"
                      className="nc-numeric"
                      type="text"
                      inputMode="numeric"
                      placeholder="1"
                      value={lkiVersion}
                      onChange={(e) => setLkiVersion(e.target.value)}
                      disabled={!formUsable}
                    />
                  </div>
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

                {showStretchFields && (
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="entry-average-width">
                        Average width (m)
                      </label>
                      <Input
                        id="entry-average-width"
                        className="nc-numeric"
                        type="text"
                        inputMode="decimal"
                        placeholder="5.50"
                        value={averageWidth}
                        onChange={(e) => setAverageWidth(e.target.value)}
                        disabled={!formUsable}
                      />
                    </div>
                    {applicationRate && (
                      <div className="flex-1">
                        <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="entry-area">
                          Area (m²)
                        </label>
                        <Input
                          id="entry-area"
                          className="nc-numeric"
                          type="text"
                          inputMode="decimal"
                          value={area}
                          onChange={(e) => {
                            setAreaFieldTouched(true)
                            setArea(e.target.value)
                          }}
                          disabled={!formUsable}
                        />
                      </div>
                    )}
                  </div>
                )}
                {/* Never an alarm tone — a difference here can legitimately
                    mean the field sheet's own measured figure, which
                    supersedes the width x reach calculation by standing
                    rule on this contract, not an error to correct. */}
                {showStretchFields && areaDiff !== null && areaDiff !== 0 && (
                  <p className="-mt-1 text-xs text-nc-text-muted">
                    {areaUnit ? 'Quantity' : 'Area'} is {fmtQuantity(Math.abs(areaDiff))} m² {areaDiff > 0 ? 'more' : 'less'} than width × reach ({fmtQuantity(computedArea)} m²).
                  </p>
                )}

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
                    onChange={(e) => {
                      if (areaUnit) setAreaFieldTouched(true)
                      if (derivationRule) setDerivedQuantityTouched(true)
                      setQuantity(e.target.value)
                    }}
                    required
                    disabled={!formUsable}
                  />
                  {selectedItem && selectedItem.itemKind === 'lump_sum' && <p className="mt-1 text-xs text-nc-text-muted">Lump-sum item — quantity is a % or portion complete, per contract convention.</p>}
                  {areaUnit && <p className="mt-1 text-xs text-nc-text-subtle">This Item's quantity is its area — no separate area field.</p>}
                  {derivationRule && (
                    <p className="mt-1 text-xs text-nc-text-subtle">
                      Derived: {derivationRule.coefficient} × {derivationRule.basis} of {derivationRule.sourceItemIds.length} Item{derivationRule.sourceItemIds.length === 1 ? '' : 's'} recorded{' '}
                      {formatDayLabel(workDate)}.
                    </p>
                  )}
                  {derivationRule && derivationDiff !== null && derivationDiff !== 0 && (
                    // Never an alarm tone — the field sheet's own figure
                    // supersedes the derivation by the same standing rule
                    // as area, not an error to correct.
                    <p className="mt-1 text-xs text-nc-text-muted">
                      Entered quantity is {fmtQuantity(Math.abs(derivationDiff))} {selectedItem?.unit} {derivationDiff > 0 ? 'more' : 'less'} than the derived figure (
                      {derivedProposal === null ? '—' : fmtQuantity(derivedProposal)} {selectedItem?.unit}).
                    </p>
                  )}
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
                  title={!formUsable ? `Needs permission to ${editingId ? 'enter' : correctingId ? 'correct' : 'enter'} quantities` : undefined}
                >
                  {submitting ? 'Saving…' : !formUsable ? 'Not permitted' : editingId ? 'Save changes' : correctingId ? 'Save correction' : 'Add entry'}
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
