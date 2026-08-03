import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconCalendarPlus } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { useSession } from '../../lib/useSession'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { confirmQuantityRecord, fetchDistinctLocations, fetchQuantityRecordsForDate, pushQuantityRecord } from '../../lib/supabase/quantityRecords'
import type { QueuedQuantityRecord } from '../../lib/db'
import { getDeviceId } from '../../lib/deviceId'
import { errorMessage } from '../../lib/errorMessage'
import { todayLocalDateString } from '../../lib/dateFormat'
import { quantity as fmtQuantity, station } from '../../lib/format'
import { Button, EmptyState, Input, NotificationBanner, PageHeader, Select, Spinner, StatusBadge, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

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

  const subtitle = `${contract.name} · ${workDate}${status === 'ready' ? ` · ${records.length} record${records.length === 1 ? '' : 's'}` : ''}`

  // Which half of the form is live depends on the row's mode, not a single
  // screen-wide flag: entering a new original needs enter_quantity, saving a
  // correction needs correct_quantity. A seat with only one of the two can
  // still reach this screen (see the gate below) — the other half stays
  // visible but disabled rather than the screen being hidden outright, per
  // 0008's UI-gating rule (disabled/read-only over hidden).
  const formUsable = correctingId ? canCorrect : canEnter

  return (
    <div>
      <PageHeader
        title="Daily entry"
        subtitle={subtitle}
        actions={
          <Input
            type="date"
            className="w-auto"
            value={workDate}
            onChange={(e) => {
              setWorkDate(e.target.value)
              resetForm()
            }}
            aria-label="Date"
          />
        }
      />

      {!canEnter && !canCorrect ? (
        <EmptyState title="Desk entry needs enter_quantity or correct_quantity on this contract." />
      ) : (
        <>
          {correctingId && (
            <NotificationBanner tone="info" className="mb-4 flex items-center justify-between gap-4">
              <span>Correcting a prior entry — the original stays in the total until this correction is confirmed.</span>
              <Button type="button" variant="ghost" onClick={resetForm}>
                Cancel
              </Button>
            </NotificationBanner>
          )}

          {/* A card with flex-wrap fields, not a single rigid table row —
              seven fields plus the submit button never fit one row at
              1440px (the button rendered ~330px past the right edge, fully
              unreachable). Wrapping to a second row here instead of
              overflowing horizontally. */}
          <form onSubmit={handleSubmit} className="mb-6 rounded-lg border border-nc-border bg-nc-secondary p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Add a record</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-32">
                <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="de-item">
                  Item #
                </label>
                <Select id="de-item" value={itemId} onChange={(e) => setItemId(e.target.value)} onKeyDown={handleFormKeyDown} disabled={!formUsable}>
                  {items.length === 0 && <option value="">No items</option>}
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.itemNumber}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="min-w-[180px] flex-1">
                <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="de-location">
                  Location
                </label>
                <Input
                  id="de-location"
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
              </div>
              <div className="w-28">
                <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="de-station-from">
                  Station from
                </label>
                <Input
                  id="de-station-from"
                  ref={stationFromRef}
                  className="nc-numeric"
                  type="number"
                  step="0.001"
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
                  type="number"
                  step="0.001"
                  value={fields.stationTo}
                  onChange={(e) => setFields({ ...fields, stationTo: e.target.value })}
                  onKeyDown={handleFormKeyDown}
                  disabled={!formUsable}
                />
              </div>
              <div className="w-20">
                <p className="mb-1 text-xs text-nc-text-muted">Reach (m)</p>
                <p className="nc-numeric px-3 py-2 text-sm text-nc-text-muted">{reachMetres !== null ? station(reachMetres, 1) : '—'}</p>
              </div>
              <div className="w-28">
                <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="de-quantity">
                  Quantity
                </label>
                <Input
                  id="de-quantity"
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
                <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="de-note">
                  Note
                </label>
                <Input id="de-note" value={fields.note} onChange={(e) => setFields({ ...fields, note: e.target.value })} onKeyDown={handleFormKeyDown} disabled={!formUsable} />
              </div>
              <Button type="submit" disabled={submitting || !formUsable} title={!formUsable ? `Needs ${correctingId ? 'correct_quantity' : 'enter_quantity'}` : undefined}>
                {submitting ? 'Adding…' : !formUsable ? 'Not permitted' : correctingId ? 'Save correction' : 'Add — Enter'}
              </Button>
            </div>
          </form>
          {formError && (
            <NotificationBanner tone="danger" className="mb-4">
              {formError}
            </NotificationBanner>
          )}

          {status === 'loading' && (
            <div className="flex items-center gap-2 py-8 text-nc-text-muted">
              <Spinner />
              <span className="text-sm">Loading…</span>
            </div>
          )}
          {status === 'error' && loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}

          {status === 'ready' &&
            (records.length === 0 ? (
              <EmptyState icon={<IconCalendarPlus size={32} stroke={1.5} />} title={`No entries yet for ${workDate}.`} description="Add the day's first record above." />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Item #</TH>
                    <TH>Location</TH>
                    <TH align="right">Station</TH>
                    <TH align="right">Quantity</TH>
                    <TH>Note</TH>
                    <TH>Status</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {records.map((r) => {
                    const item = itemById.get(r.itemId)
                    return (
                      <TR key={r.id}>
                        <TD className="nc-numeric">{item?.itemNumber ?? r.itemId.slice(0, 8)}</TD>
                        <TD prose>{r.location}</TD>
                        <TD align="right" className="nc-numeric">
                          {r.stationFrom !== null ? `${station(r.stationFrom)}${r.stationTo !== null ? `–${station(r.stationTo)}` : ''}` : ''}
                        </TD>
                        <TD align="right" className="nc-numeric">
                          {fmtQuantity(r.quantity, item?.unit)}
                        </TD>
                        <TD prose>{r.note}</TD>
                        <TD>
                          <div className="flex flex-wrap items-center gap-1">
                            <StatusBadge status={r.status} />
                            {supersededByConfirmed.has(r.id) && <StatusBadge status="superseded" />}
                          </div>
                        </TD>
                        <TD dense>
                          <div className="flex items-center gap-2">
                            {r.status === 'draft' && (
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={confirmingId === r.id || !contract.confirmQuantity}
                                title={!contract.confirmQuantity ? 'Needs confirm_quantity' : undefined}
                                onClick={() => void handleConfirm(r.id)}
                              >
                                {confirmingId === r.id ? 'Confirming…' : 'Confirm'}
                              </Button>
                            )}
                            <Button type="button" variant="secondary" disabled={!canCorrect} title={!canCorrect ? 'Needs correct_quantity' : undefined} onClick={() => startCorrection(r)}>
                              Correct
                            </Button>
                          </div>
                        </TD>
                      </TR>
                    )
                  })}
                </TBody>
              </Table>
            ))}
        </>
      )}
    </div>
  )
}
