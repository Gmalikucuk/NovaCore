import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useOutletContext, useSearchParams } from 'react-router-dom'
import { IconCalendarPlus, IconChevronDown } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { useSession } from '../../lib/useSession'
import { fetchItems, isUnitPriceItem, type Item } from '../../lib/supabase/items'
import { confirmQuantityRecord, fetchContractQuantityRecords, fetchDistinctLocations, pushQuantityRecord } from '../../lib/supabase/quantityRecords'
import { fetchItemMonths } from '../../lib/supabase/monthlyPeriods'
import type { QueuedQuantityRecord } from '../../lib/db'
import { getDeviceId } from '../../lib/deviceId'
import { errorMessage } from '../../lib/errorMessage'
import { formatDayLabel, todayLocalDateString } from '../../lib/dateFormat'
import { parseStation, quantity as fmtQuantity, station } from '../../lib/format'
import { compareItemCodes } from '../../lib/calculations/naturalSort'
import { filterEffective } from '../../lib/calculations/effectiveEntries'
import { Button, EmptyState, Input, NotificationBanner, PageHeader, SandboxBanner, StatusBadge, Spinner } from '../../components/ui'

type DayRecord = Omit<QueuedQuantityRecord, 'pending' | 'lastError'>

const BLANK = { location: '', stationFrom: '', stationTo: '', quantity: '', note: '' }

const LOCATIONS_LIST_ID = 'daily-entry-locations'

export function QuantityRecordsScreen() {
  const contract = useOutletContext<MyContract>()
  const canEnter = contract.enterQuantity
  const canCorrect = contract.correctQuantity
  const session = useSession()
  const userId = session?.user.id ?? null

  // Work date is still page-level: it's what a NEW entry gets stamped
  // with, not a filter on what's shown — the per-Item panels below always
  // show that Item's own pending/confirmed history regardless of date, per
  // the "where did the last work leave off" requirement.
  const [workDate, setWorkDate] = useState(todayLocalDateString())
  const [items, setItems] = useState<Item[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [allRecords, setAllRecords] = useState<DayRecord[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  const [searchParams] = useSearchParams()
  const hasAppliedDeepLink = useRef(false)
  const panelRefs = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    fetchItems(contract.id)
      .then(setItems)
      .catch((err: unknown) => setLoadError(errorMessage(err)))
    fetchDistinctLocations(contract.id)
      .then(setLocations)
      .catch(() => {
        /* autocomplete only — not worth surfacing as a page error */
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

  // Used after a submit/confirm inside an expanded panel — refreshes the
  // data without dropping back to a page-wide loading state, which would
  // otherwise blank out every other expanded panel on screen.
  function refreshSilently() {
    fetchContractQuantityRecords(contract.id)
      .then(setAllRecords)
      .catch((err: unknown) => setLoadError(errorMessage(err)))
  }

  // A quantity_records row only measures something for a unit_price Item
  // (GC 52.03) — Lump Sum and Provisional Sum Items are excluded from this
  // list entirely, not shown greyed. Their whole mechanic (expand -> log a
  // quantity against a date) doesn't apply to either kind, so a disabled
  // row would just be inert clutter with no action available on it; the
  // Items screen is still where their existence is visible.
  const unitPriceItems = useMemo(() => items.filter(isUnitPriceItem).sort((a, b) => compareItemCodes(a.itemNumber, b.itemNumber)), [items])

  const recordsByItem = useMemo(() => {
    const map = new Map<string, DayRecord[]>()
    for (const r of allRecords) {
      const list = map.get(r.itemId)
      if (list) list.push(r)
      else map.set(r.itemId, [r])
    }
    return map
  }, [allRecords])

  const recordById = useMemo(() => new Map(allRecords.map((r) => [r.id, r])), [allRecords])

  // Deep link from Tracker/Finance: ?itemId=&period= expands that Item in
  // place (no separate route to land on) and, when a period is given,
  // dates new entries to the period's first working day. Waits for items
  // to have loaded so the target panel actually exists to scroll to.
  useEffect(() => {
    if (hasAppliedDeepLink.current || items.length === 0) return
    const deepLinkItemId = searchParams.get('itemId')
    const deepLinkPeriod = searchParams.get('period')
    if (!deepLinkItemId && !deepLinkPeriod) return
    hasAppliedDeepLink.current = true
    if (deepLinkItemId) {
      setExpandedIds((prev) => new Set(prev).add(deepLinkItemId))
      requestAnimationFrame(() => panelRefs.current.get(deepLinkItemId)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
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

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function setPanelRef(id: string) {
    return (el: HTMLDivElement | null) => {
      if (el) panelRefs.current.set(id, el)
      else panelRefs.current.delete(id)
    }
  }

  const subtitle = `${contract.name} · ${unitPriceItems.length} Unit Price item${unitPriceItems.length === 1 ? '' : 's'}`

  return (
    <div>
      <PageHeader
        title="Daily entry"
        subtitle={subtitle}
        actions={
          <div className="flex items-center gap-2">
            <label htmlFor="de-work-date" className="text-xs text-nc-text-muted">
              New entries dated
            </label>
            <Input id="de-work-date" type="date" className="w-auto" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
          </div>
        }
      />

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

          {status === 'ready' &&
            (unitPriceItems.length === 0 ? (
              <EmptyState
                icon={<IconCalendarPlus size={32} stroke={1.5} />}
                title="No Unit Price items to record time against yet."
                description="Lump Sum and Provisional Sum items aren't recorded by quantity."
              />
            ) : (
              <div className="space-y-3">
                {unitPriceItems.map((item) => (
                  <ItemEntryPanel
                    key={item.id}
                    item={item}
                    records={recordsByItem.get(item.id) ?? []}
                    recordById={recordById}
                    workDate={workDate}
                    contract={contract}
                    userId={userId}
                    expanded={expandedIds.has(item.id)}
                    onToggleExpand={() => toggleExpanded(item.id)}
                    onChanged={refreshSilently}
                    panelRef={setPanelRef(item.id)}
                  />
                ))}
              </div>
            ))}
        </>
      )}
    </div>
  )
}

interface ItemEntryPanelProps {
  item: Item
  records: DayRecord[]
  recordById: Map<string, DayRecord>
  workDate: string
  contract: MyContract
  userId: string | null
  expanded: boolean
  onToggleExpand: () => void
  onChanged: () => void
  panelRef: (el: HTMLDivElement | null) => void
}

function ItemEntryPanel({ item, records, recordById, workDate, contract, userId, expanded, onToggleExpand, onChanged, panelRef }: ItemEntryPanelProps) {
  const canEnter = contract.enterQuantity
  const canCorrect = contract.correctQuantity

  const [fields, setFields] = useState(BLANK)
  const [correctingId, setCorrectingId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const stationFromRef = useRef<HTMLInputElement>(null)

  // Unconfirmed, newest first — everything still provisional, which can be
  // superseded again before it ever counts. Not filtered to this Item's
  // "current" chain head deliberately; a stray draft-corrects-draft is an
  // edge case this list still surfaces honestly rather than hiding.
  const unconfirmed = useMemo(
    () =>
      records
        .filter((r) => r.status === 'draft')
        .sort((a, b) => (a.workDate === b.workDate ? b.createdAt.localeCompare(a.createdAt) : b.workDate.localeCompare(a.workDate))),
    [records],
  )

  // The settled reference: the most recent EFFECTIVE confirmed entry
  // (confirmed, no confirmed successor) — mirrors quantity_records_effective,
  // so a confirmed row that's already been superseded by a confirmed
  // correction correctly drops out in favour of the row that replaced it.
  const lastConfirmed = useMemo(() => {
    const effective = filterEffective(records)
    if (effective.length === 0) return null
    return effective.reduce((latest, r) => (r.workDate > latest.workDate || (r.workDate === latest.workDate && r.createdAt > latest.createdAt) ? r : latest))
  }, [records])

  const correctionPendingOnLastConfirmed = lastConfirmed !== null && unconfirmed.some((u) => u.supersedes === lastConfirmed.id)

  const reachMetres = useMemo(() => {
    const from = parseStation(fields.stationFrom)
    const to = parseStation(fields.stationTo)
    if (from === null || to === null) return null
    return to - from
  }, [fields.stationFrom, fields.stationTo])

  const formUsable = correctingId ? canCorrect : canEnter

  function resetForm() {
    setFields(BLANK)
    setCorrectingId(null)
    setFormError(null)
  }

  function startCorrection(record: DayRecord) {
    setCorrectingId(record.id)
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
      onChanged()
    } catch (err) {
      setFormError(errorMessage(err))
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

    setSubmitting(true)
    try {
      await pushQuantityRecord({
        id: crypto.randomUUID(),
        contractId: item.contractId,
        itemId: item.id,
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
      onChanged()
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

  function recordLine(r: DayRecord) {
    return (
      <>
        {formatDayLabel(r.workDate)} · <span className="nc-numeric">{fmtQuantity(r.quantity, item.unit)}</span>
        {r.stationFrom !== null && (
          <span className="nc-numeric text-nc-text-muted">
            {' '}
            · {station(r.stationFrom)}
            {r.stationTo !== null ? `–${station(r.stationTo)}` : ''}
          </span>
        )}
        {r.location && <span className="text-nc-text-muted"> · {r.location}</span>}
      </>
    )
  }

  return (
    <div ref={panelRef} className="rounded-lg border border-nc-border bg-white shadow-sm">
      <button type="button" onClick={onToggleExpand} className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left" aria-expanded={expanded}>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="nc-numeric text-sm font-semibold text-nc-text">{item.itemNumber}</span>
            <span className="truncate text-sm text-nc-text-muted">{item.description}</span>
          </div>
          <p className="mt-0.5 text-xs text-nc-text-muted">
            {lastConfirmed ? (
              <>
                Last confirmed: {fmtQuantity(lastConfirmed.quantity, item.unit)} on {formatDayLabel(lastConfirmed.workDate)}
              </>
            ) : (
              'No confirmed entries yet'
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {unconfirmed.length > 0 && <StatusBadge status="draft">{unconfirmed.length} pending</StatusBadge>}
          <IconChevronDown size={18} className={`text-nc-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-nc-border px-4 py-4">
          {correctingId && (
            <NotificationBanner tone="info" className="mb-4 flex items-center justify-between gap-4">
              <span>Correcting a prior entry — the original stays in the total until this correction is confirmed.</span>
              <Button type="button" variant="ghost" onClick={resetForm}>
                Cancel
              </Button>
            </NotificationBanner>
          )}

          <form onSubmit={handleSubmit} className="mb-4 rounded-md border border-nc-border bg-nc-secondary p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[180px] flex-1">
                <label className="mb-1 block text-xs text-nc-text-muted" htmlFor={`de-location-${item.id}`}>
                  Location
                </label>
                <Input
                  id={`de-location-${item.id}`}
                  list={LOCATIONS_LIST_ID}
                  value={fields.location}
                  onChange={(e) => setFields({ ...fields, location: e.target.value })}
                  onKeyDown={handleFormKeyDown}
                  disabled={!formUsable}
                />
              </div>
              <div className="w-28">
                <label className="mb-1 block text-xs text-nc-text-muted" htmlFor={`de-station-from-${item.id}`}>
                  Station from
                </label>
                <Input
                  id={`de-station-from-${item.id}`}
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
                <label className="mb-1 block text-xs text-nc-text-muted" htmlFor={`de-station-to-${item.id}`}>
                  Station to
                </label>
                <Input
                  id={`de-station-to-${item.id}`}
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
              <div className="w-28">
                <label className="mb-1 block text-xs text-nc-text-muted" htmlFor={`de-quantity-${item.id}`}>
                  Quantity
                </label>
                <Input
                  id={`de-quantity-${item.id}`}
                  className="nc-numeric"
                  type="number"
                  step="0.01"
                  value={fields.quantity}
                  onChange={(e) => setFields({ ...fields, quantity: e.target.value })}
                  onKeyDown={handleFormKeyDown}
                  disabled={!formUsable}
                />
              </div>
              <div className="min-w-[200px] flex-1">
                <label className="mb-1 block text-xs text-nc-text-muted" htmlFor={`de-note-${item.id}`}>
                  Note
                </label>
                <Input
                  id={`de-note-${item.id}`}
                  value={fields.note}
                  onChange={(e) => setFields({ ...fields, note: e.target.value })}
                  onKeyDown={handleFormKeyDown}
                  disabled={!formUsable}
                />
              </div>
              <Button type="submit" disabled={submitting || !formUsable} title={!formUsable ? `Needs permission to ${correctingId ? 'correct' : 'enter'} quantities` : undefined}>
                {submitting ? 'Adding…' : !formUsable ? 'Not permitted' : correctingId ? 'Save correction' : 'Add — Enter'}
              </Button>
            </div>
          </form>
          {formError && (
            <NotificationBanner tone="danger" className="mb-4">
              {formError}
            </NotificationBanner>
          )}

          {/* Everything above the divider below is pending; the one thing
              below it is settled. Tone carries that: warning badges up
              here, a single success badge down there — no legend needed. */}
          {unconfirmed.length > 0 && (
            <div className="mb-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Pending, newest first</p>
              <div className="space-y-2">
                {unconfirmed.map((r) => {
                  const target = r.supersedes ? recordById.get(r.supersedes) : undefined
                  return (
                    <div key={r.id} className="rounded-md border border-nc-border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm text-nc-text">{recordLine(r)}</div>
                        <div className="flex items-center gap-2">
                          <StatusBadge status="draft" />
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={confirmingId === r.id || !contract.confirmQuantity}
                            title={!contract.confirmQuantity ? 'Needs permission to confirm quantity records' : undefined}
                            onClick={() => void handleConfirm(r.id)}
                          >
                            {confirmingId === r.id ? 'Confirming…' : 'Confirm'}
                          </Button>
                          <Button type="button" variant="secondary" disabled={!canCorrect} title={!canCorrect ? 'Needs permission to correct quantity records' : undefined} onClick={() => startCorrection(r)}>
                            Correct
                          </Button>
                        </div>
                      </div>
                      {r.note && <p className="mt-1 text-xs text-nc-text-muted">{r.note}</p>}
                      {target && (
                        <p className="mt-1 text-xs text-nc-info-text">
                          Corrects {fmtQuantity(target.quantity, item.unit)} {target.status === 'confirmed' ? 'confirmed' : 'pending'} on {formatDayLabel(target.workDate)}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="border-t border-nc-border pt-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Last confirmed</p>
            {lastConfirmed ? (
              <div className="rounded-md border border-nc-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm text-nc-text">{recordLine(lastConfirmed)}</div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status="confirmed" />
                    <Button type="button" variant="secondary" disabled={!canCorrect} title={!canCorrect ? 'Needs permission to correct quantity records' : undefined} onClick={() => startCorrection(lastConfirmed)}>
                      Correct
                    </Button>
                  </div>
                </div>
                {lastConfirmed.note && <p className="mt-1 text-xs text-nc-text-muted">{lastConfirmed.note}</p>}
                {correctionPendingOnLastConfirmed && <p className="mt-1 text-xs text-nc-info-text">A correction above is pending confirmation — this figure still counts until then.</p>}
              </div>
            ) : (
              <div className="rounded-md border border-nc-border bg-nc-secondary px-3 py-2 text-sm text-nc-text-muted">Nothing confirmed yet.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
