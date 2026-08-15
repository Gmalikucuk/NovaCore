import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { IconArrowLeft, IconChevronDown } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchEffectiveProductionRecords } from '../../lib/supabase/dashboard'
import {
  addProgressEstimateItem,
  fetchPriorClaimQuantities,
  fetchProgressEstimate,
  fetchProgressEstimateItems,
  fetchProgressEstimateSummaries,
  fetchUnitPricesForClaims,
  updateProgressEstimateItemClaim,
  updateProgressEstimateItemProjected,
  updateProgressEstimateStatus,
  type ProgressEstimate,
  type ProgressEstimateItem,
  type ProgressEstimateStatus,
  type ProgressEstimateSummary,
} from '../../lib/supabase/progressEstimates'
import { fetchViewPreferences, saveViewPreferences } from '../../lib/supabase/viewPreferences'
import { fetchItems, type Item } from '../../lib/supabase/items'
import {
  claimFieldForKind,
  percentOfApproximate,
  proposeClaimedFromRecords,
  quantityToDate,
  tenderedExtendedAmount,
  type ProposedClaim,
} from '../../lib/calculations/progressEstimates'
import { formatDayLabel } from '../../lib/dateFormat'
import { errorMessage } from '../../lib/errorMessage'
import { quantity as fmtQuantity, rate as fmtRate } from '../../lib/format'
import { Button, EmptyState, Input, NotificationBanner, PageHeader, SandboxBanner, Select, Spinner, StatCard, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

const STATUS_OPTIONS: ProgressEstimateStatus[] = ['draft', 'submitted', 'received', 'reconciled']
const STATUS_LABEL: Record<ProgressEstimateStatus, string> = { draft: 'Draft', submitted: 'Submitted', received: 'Received', reconciled: 'Reconciled' }
// Same mapping as the list screen's STATUS_TONE_CLASS — duplicated rather
// than shared, matching STATUS_LABEL's own precedent above.
const STATUS_TONE_CLASS: Record<ProgressEstimateStatus, string> = {
  draft: 'bg-nc-warning-bg text-nc-warning-text',
  submitted: 'bg-nc-info-bg text-nc-info-text',
  received: 'bg-nc-ready-bg text-nc-ready-text',
  reconciled: 'bg-nc-success-bg text-nc-success-text',
}

/**
 * Status as a pill in the header, beside the period — the control IS the
 * pill (a styled <select>), not a badge next to a separate dropdown. One
 * fact, one control, no bordered card of its own.
 */
function StatusPill({ status, onChange, disabled }: { status: ProgressEstimateStatus; onChange: (next: ProgressEstimateStatus) => void; disabled: boolean }) {
  return (
    <span className="relative inline-flex items-center">
      <select
        aria-label="Status"
        value={status}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ProgressEstimateStatus)}
        className={`appearance-none rounded-full border-0 py-0.5 pl-2.5 pr-6 text-xs font-medium disabled:cursor-not-allowed ${disabled ? '' : 'cursor-pointer'} ${STATUS_TONE_CLASS[status]}`}
      >
        {STATUS_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      {!disabled && <IconChevronDown size={12} stroke={2} className="pointer-events-none absolute right-2" />}
    </span>
  )
}

const PREFS_SCOPE = 'progress_estimate_detail'
type LineFilter = 'all' | 'claimed' | 'not_started'
const FILTER_LABEL: Record<LineFilter, string> = { all: 'All items', claimed: 'Claimed this period', not_started: 'Not started' }

function parseNum(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isNaN(n) ? null : n
}

function sanitizeFilter(raw: unknown): LineFilter {
  return raw === 'claimed' || raw === 'not_started' ? raw : 'all'
}

/**
 * Description + identity line — the Item's unit of measure and Approximate
 * Quantity live here, once, not repeated in every numeric cell (§2). A
 * projected overrun is stated on this same line, as plain text, only when
 * it actually IS one (projected > 100% of Approximate Quantity) — over-
 * quantity is revenue above tender, not styled as a problem.
 */
function ItemIdentity({ line }: { line: ProgressEstimateItem }) {
  const kindLabel = line.itemKind === 'lump_sum' ? 'lump sum' : line.itemKind === 'provisional_sum' ? 'provisional sum' : line.unit
  const percentProjected = line.itemKind === 'unit_price' ? percentOfApproximate(line.projectedQuantity, line.approximateQuantity) : null
  const overrun = percentProjected !== null && percentProjected > 100 ? ` · ${percentProjected.toFixed(0)}% projected` : ''
  return (
    <div>
      <div className="max-w-[320px] truncate text-sm text-nc-text" title={line.description}>
        {line.description}
      </div>
      <div className="mt-0.5 max-w-[320px] text-xs text-nc-text-muted">
        {line.itemNumber} · {kindLabel}
        {line.itemKind === 'unit_price' && <> · {fmtQuantity(line.approximateQuantity)} approx.</>}
        {overrun}
      </div>
    </div>
  )
}

/**
 * One claim line, unit_price Items only (§1's four columns apply to the
 * quantity-measured case this brief was written against — Lump Sum/
 * Provisional Sum lines render in the separate, minimal list further down,
 * where "this period" has no equivalent meaning). Returns a Fragment of
 * ONE OR TWO <TR>s: the row itself, and — when expanded — the detail panel
 * directly beneath it, so later rows shift down and the row being worked
 * on never moves (§3).
 *
 * "This period" is the only input in the row itself; Quantity to date and
 * Value are both computed live from it, matching §1 ("everything else is
 * derived or carried"). previousQuantity/claimed freeze/prepare_claims
 * gating are unchanged from 65e2a0f — this component only changes what is
 * shown and where, not what is enforced (the database still owns that).
 */
function ClaimLine({
  line,
  rowIndex,
  isDraft,
  canWrite,
  unitPrice,
  proposedClaim,
  expanded,
  onToggleExpand,
  onChanged,
}: {
  line: ProgressEstimateItem
  rowIndex: number
  isDraft: boolean
  canWrite: boolean
  unitPrice: number | null
  proposedClaim: ProposedClaim | undefined
  expanded: boolean
  onToggleExpand: () => void
  onChanged: () => void
}) {
  const [thisPeriodDraft, setThisPeriodDraft] = useState(line.claimedQuantity?.toString() ?? '')
  const [projectedDraft, setProjectedDraft] = useState(line.projectedQuantity?.toString() ?? '')
  const [saveError, setSaveError] = useState<string | null>(null)

  const thisPeriodParsed = parseNum(thisPeriodDraft)
  // Live preview of the running total — previousQuantity alone before any
  // entry this period, then previousQuantity + this period as it's typed.
  const toDate = quantityToDate(line.previousQuantity, thisPeriodParsed)
  const liveValue = thisPeriodParsed === null || unitPrice === null ? null : thisPeriodParsed * unitPrice
  const tendered = tenderedExtendedAmount(line.approximateQuantity, unitPrice)

  async function commitThisPeriod() {
    if (thisPeriodParsed === line.claimedQuantity) return
    try {
      await updateProgressEstimateItemClaim(line.id, {
        claimedQuantity: thisPeriodParsed,
        claimedValue: thisPeriodParsed === null || unitPrice === null ? null : thisPeriodParsed * unitPrice,
      })
      onChanged()
    } catch (err) {
      setSaveError(errorMessage(err))
    }
  }

  async function commitProjected() {
    const value = parseNum(projectedDraft)
    if (value === line.projectedQuantity) return
    try {
      await updateProgressEstimateItemProjected(line.id, value)
      onChanged()
    } catch (err) {
      setSaveError(errorMessage(err))
    }
  }

  function useProposal() {
    if (!proposedClaim) return
    setThisPeriodDraft(proposedClaim.claimedQuantity.toString())
  }

  return (
    <>
      <TR className="cursor-pointer hover:bg-nc-secondary" onClick={onToggleExpand}>
        <TD className="align-top">
          <ItemIdentity line={line} />
        </TD>
        <TD align="right" className="nc-numeric align-top">
          {toDate === null ? '—' : fmtQuantity(toDate)}
        </TD>
        <TD align="right" className="align-top" onClick={(e) => e.stopPropagation()}>
          {canWrite && isDraft ? (
            <Input
              className="nc-numeric text-right"
              inputMode="decimal"
              style={{ width: 110 }}
              value={thisPeriodDraft}
              tabIndex={rowIndex + 1}
              aria-label={`${line.itemNumber} this period`}
              onChange={(e) => setThisPeriodDraft(e.target.value)}
              onBlur={() => void commitThisPeriod()}
            />
          ) : (
            <span className="nc-numeric">{line.claimedQuantity === null ? '—' : fmtQuantity(line.claimedQuantity)}</span>
          )}
          {saveError && <p className="mt-1 text-xs text-nc-danger-text">{saveError}</p>}
        </TD>
        <TD align="right" className="nc-numeric align-top">
          {fmtRate(liveValue)}
        </TD>
      </TR>
      {expanded && (
        <TR className="bg-nc-secondary" onClick={(e) => e.stopPropagation()}>
          <TD colSpan={4} className="align-top">
            <div className="grid grid-cols-4 gap-6 py-2">
              <label className="text-xs text-nc-text-muted">
                Projected final quantity
                {canWrite ? (
                  <Input
                    className="nc-numeric mt-1 text-right"
                    inputMode="decimal"
                    tabIndex={-1}
                    value={projectedDraft}
                    aria-label={`${line.itemNumber} projected final quantity`}
                    onChange={(e) => setProjectedDraft(e.target.value)}
                    onBlur={() => void commitProjected()}
                  />
                ) : (
                  <div className="nc-numeric mt-1 text-right text-sm text-nc-text">{line.projectedQuantity === null ? '—' : fmtQuantity(line.projectedQuantity, line.unit)}</div>
                )}
              </label>
              <div className="text-xs text-nc-text-muted">
                From records
                <div className="mt-1 text-sm text-nc-text">
                  {proposedClaim ? (
                    <>
                      {fmtQuantity(proposedClaim.claimedQuantity, line.unit)}{' '}
                      {canWrite && isDraft && (
                        <button type="button" className="text-nc-link underline" onClick={useProposal}>
                          Use
                        </button>
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </div>
              </div>
              <div className="text-xs text-nc-text-muted">
                Unit Price
                <div className="nc-numeric mt-1 text-sm text-nc-text">{fmtRate(unitPrice)}</div>
              </div>
              <div className="text-xs text-nc-text-muted">
                Tendered extended amount
                <div className="nc-numeric mt-1 text-sm text-nc-text">{fmtRate(tendered)}</div>
              </div>
            </div>
          </TD>
        </TR>
      )}
    </>
  )
}

/**
 * Lump Sum / Provisional Sum lines — only ever present if added by hand
 * (they're never auto-created, 65e2a0f). §1's four-column redesign doesn't
 * fit them: there is no "this period" quantity concept for a percent-
 * complete or one-time authorized-value figure. Kept minimal rather than
 * forced into a shape that doesn't describe them — one input, matching
 * whichever field claimFieldForKind says is live, nothing else.
 */
function OtherLine({ line, isDraft, canWrite, onChanged }: { line: ProgressEstimateItem; isDraft: boolean; canWrite: boolean; onChanged: () => void }) {
  const field = claimFieldForKind(line.itemKind)
  const claimedValue = field === 'percent' ? line.claimedPercent : line.claimedValue
  const [draft, setDraft] = useState(claimedValue?.toString() ?? '')
  const [saveError, setSaveError] = useState<string | null>(null)

  async function commit() {
    const value = parseNum(draft)
    if (value === claimedValue) return
    try {
      await updateProgressEstimateItemClaim(line.id, field === 'percent' ? { claimedPercent: value } : { claimedValue: value })
      onChanged()
    } catch (err) {
      setSaveError(errorMessage(err))
    }
  }

  return (
    <TR>
      <TD className="align-top">
        <div className="max-w-[320px] truncate text-sm text-nc-text" title={line.description}>
          {line.description}
        </div>
        <div className="mt-0.5 text-xs text-nc-text-muted">
          {line.itemNumber} · {line.itemKind === 'lump_sum' ? 'lump sum' : 'provisional sum'}
        </div>
      </TD>
      <TD align="right" className="align-top">
        {canWrite && isDraft ? (
          <Input
            className="nc-numeric text-right"
            inputMode="decimal"
            style={{ width: 110 }}
            value={draft}
            aria-label={`${line.itemNumber} ${field === 'percent' ? '% complete' : 'value'}`}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
          />
        ) : (
          <span className="nc-numeric">{claimedValue === null ? '—' : field === 'percent' ? `${claimedValue.toFixed(1)}%` : fmtRate(claimedValue)}</span>
        )}
        {saveError && <p className="mt-1 text-xs text-nc-danger-text">{saveError}</p>}
      </TD>
    </TR>
  )
}

/**
 * One progress estimate's detail, redesigned around one question per Item:
 * how much of this got done this period. Four columns, one expandable
 * panel per row for everything else that's worth seeing but isn't the
 * input, filters instead of scrolling past settled rows, and the summary
 * as four cards plus holdback retained to date — the answer, not a footer.
 */
export function ProgressEstimateScreen() {
  const contract = useOutletContext<MyContract>()
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()

  const [estimate, setEstimate] = useState<ProgressEstimate | null>(null)
  const [lines, setLines] = useState<ProgressEstimateItem[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [unitPriceByItem, setUnitPriceByItem] = useState<Map<string, number | null>>(new Map())
  const [productionRecords, setProductionRecords] = useState<{ itemId: string; workDate: string; quantity: number }[]>([])
  const [priorQuantityByItem, setPriorQuantityByItem] = useState<Map<string, number | null>>(new Map())
  const [summaries, setSummaries] = useState<ProgressEstimateSummary[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [statusSaving, setStatusSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<LineFilter>('all')
  const filterLoaded = useRef(false)
  const lastPersistedFilter = useRef<string | null>(null)

  const [addItemId, setAddItemId] = useState('')
  const [addItemValue, setAddItemValue] = useState('')
  const [addingItem, setAddingItem] = useState(false)

  const canView = contract.viewRates || contract.prepareClaims
  const canWrite = contract.prepareClaims

  function reload() {
    if (!id) return
    return Promise.all([
      fetchProgressEstimate(id),
      fetchProgressEstimateItems(id),
      fetchItems(contract.id),
      fetchUnitPricesForClaims(contract.id),
      fetchEffectiveProductionRecords(contract.id),
      fetchPriorClaimQuantities(contract.id),
      fetchProgressEstimateSummaries(contract.id),
    ]).then(([estimateRow, lineRows, itemRows, priceRows, records, priorQuantities, summaryRows]) => {
      setEstimate(estimateRow)
      setLines(lineRows)
      setItems(itemRows)
      setUnitPriceByItem(priceRows)
      setProductionRecords(records)
      setPriorQuantityByItem(priorQuantities)
      setSummaries(summaryRows)
    })
  }

  useEffect(() => {
    setStatus('loading')
    reload()
      ?.then(() => setStatus('ready'))
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, contract.id])

  // Filter choice — per seat, per screen (not per contract or per estimate;
  // one preference follows this person everywhere they prepare a claim).
  useEffect(() => {
    fetchViewPreferences(PREFS_SCOPE)
      .then((raw) => {
        const f = sanitizeFilter(raw?.lineFilter)
        lastPersistedFilter.current = f
        setFilter(f)
      })
      .catch(() => {
        lastPersistedFilter.current = 'all'
      })
      .finally(() => {
        filterLoaded.current = true
      })
  }, [])

  useEffect(() => {
    if (!filterLoaded.current) return
    if (filter === lastPersistedFilter.current) return
    const handle = setTimeout(() => {
      void saveViewPreferences(PREFS_SCOPE, { lineFilter: filter }).then(() => {
        lastPersistedFilter.current = filter
      })
    }, 500)
    return () => clearTimeout(handle)
  }, [filter])

  const isDraft = estimate?.status === 'draft'

  const unitPriceLines = useMemo(
    () => [...lines].filter((l) => l.itemKind === 'unit_price').sort((a, b) => a.itemNumber.localeCompare(b.itemNumber, undefined, { numeric: true })),
    [lines],
  )
  const otherLines = useMemo(
    () => [...lines].filter((l) => l.itemKind !== 'unit_price').sort((a, b) => a.itemNumber.localeCompare(b.itemNumber, undefined, { numeric: true })),
    [lines],
  )

  const filteredLines = useMemo(() => {
    if (filter === 'all') return unitPriceLines
    if (filter === 'claimed') return unitPriceLines.filter((l) => l.claimedQuantity !== null)
    return unitPriceLines.filter((l) => (l.previousQuantity ?? 0) === 0 && l.claimedQuantity === null)
  }, [unitPriceLines, filter])

  // The committed figure, not a live re-derivation from whatever's mid-edit
  // in each row — the same source v_progress_estimate_summary's gross_claim
  // sums from, so on the "all items" filter (no LS/PS lines) this total and
  // the Gross claim card below are two independent computations of the same
  // number. If they ever disagree, that's a real bug to see, not to hide by
  // only ever showing one of the two figures. Null (renders as —) when
  // nothing in the filtered set has been claimed yet — a total of nothing
  // claimed is not the same fact as a total of exactly $0 claimed.
  const filteredValueTotal = useMemo(() => {
    const known = filteredLines.filter((l) => l.claimedValue !== null)
    if (known.length === 0) return null
    return known.reduce((sum, l) => sum + (l.claimedValue ?? 0), 0)
  }, [filteredLines])

  // The records-derived proposal for THIS estimate's period, unit_price
  // Items only — offered in the expanded panel, never written
  // automatically (see proposeClaimedFromRecords' own doc comment).
  const proposedByItem = useMemo(() => {
    if (!estimate) return new Map<string, ProposedClaim>()
    const unitPriceItemIds = new Set(items.filter((i) => i.itemKind === 'unit_price').map((i) => i.id))
    const claims = proposeClaimedFromRecords(productionRecords.filter((r) => unitPriceItemIds.has(r.itemId)), estimate.periodStart, estimate.periodEnd, unitPriceByItem)
    return new Map(claims.map((c) => [c.itemId, c]))
  }, [estimate, items, productionRecords, unitPriceByItem])

  const summary = useMemo(() => summaries.find((s) => s.progressEstimateId === id), [summaries, id])
  const retainedToDate = useMemo(() => {
    if (summaries.length === 0) return null
    return [...summaries].sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1))[0]?.holdbackRetainedToDate ?? null
  }, [summaries])

  const itemsNotYetAdded = useMemo(() => {
    const lineItemIds = new Set(lines.map((l) => l.itemId))
    return items.filter((i) => !lineItemIds.has(i.id)).sort((a, b) => a.itemNumber.localeCompare(b.itemNumber, undefined, { numeric: true }))
  }, [items, lines])

  async function handleStatusChange(next: ProgressEstimateStatus) {
    if (!estimate) return
    setStatusSaving(true)
    setActionError(null)
    try {
      await updateProgressEstimateStatus(estimate.id, next)
      await reload()
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setStatusSaving(false)
    }
  }

  async function handleAddItem() {
    if (!estimate || !addItemId) return
    const item = items.find((i) => i.id === addItemId)
    if (!item) return
    const field = claimFieldForKind(item.itemKind)
    const value = parseNum(addItemValue)
    setAddingItem(true)
    setActionError(null)
    try {
      await addProgressEstimateItem({
        progressEstimateId: estimate.id,
        itemId: item.id,
        contractId: contract.id,
        previousQuantity: field === 'quantity' ? (priorQuantityByItem.get(item.id) ?? null) : null,
        claimedQuantity: field === 'quantity' ? value : null,
        claimedPercent: field === 'percent' ? value : null,
        claimedValue: field === 'value' ? value : null,
      })
      setAddItemId('')
      setAddItemValue('')
      await reload()
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setAddingItem(false)
    }
  }

  if (status === 'ready' && !canView) {
    return (
      <div>
        <PageHeader title="Progress claim" subtitle={contract.name} />
        <EmptyState title="You don't have permission to view progress claims on this contract." />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Progress claim"
        subtitle={
          estimate ? (
            <span className="flex flex-wrap items-center gap-2">
              <span>
                {contract.name} · {formatDayLabel(estimate.periodStart)} → {formatDayLabel(estimate.periodEnd)}
              </span>
              <StatusPill status={estimate.status} onChange={(next) => void handleStatusChange(next)} disabled={!canWrite || statusSaving} />
              {!isDraft && <span className="text-nc-text-subtle">Claimed figures are frozen.</span>}
            </span>
          ) : (
            contract.name
          )
        }
        actions={
          <Button type="button" variant="ghost" onClick={() => navigate('/progress-estimates')}>
            <IconArrowLeft size={16} stroke={2} className="mr-1 inline" />
            Back
          </Button>
        }
      />

      <SandboxBanner contract={contract} variant="quiet" />

      {status === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-nc-text-muted">
          <Spinner />
          <span className="text-sm">Loading…</span>
        </div>
      )}
      {status === 'error' && loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}

      {status === 'ready' && estimate && (
        <>
          {actionError && (
            <NotificationBanner tone="danger" className="mb-4">
              {actionError}
            </NotificationBanner>
          )}

          <div className="mb-4 flex gap-2" role="group" aria-label="Line filter">
            {(['all', 'claimed', 'not_started'] as LineFilter[]).map((f) => (
              <Button key={f} type="button" variant={filter === f ? 'primary' : 'secondary'} onClick={() => setFilter(f)}>
                {FILTER_LABEL[f]}
              </Button>
            ))}
          </div>

          {filteredLines.length === 0 ? (
            <EmptyState title="No items match this filter." description="Try a different filter above." />
          ) : (
            <Table style={{ tableLayout: 'fixed' }}>
              <THead>
                <TR>
                  <TH style={{ width: '46%' }}>Item</TH>
                  <TH align="right" style={{ width: '20%' }}>
                    Quantity to date
                  </TH>
                  <TH align="right" style={{ width: '18%' }}>
                    This period
                  </TH>
                  <TH align="right" style={{ width: '16%' }}>
                    Value
                  </TH>
                </TR>
              </THead>
              <TBody>
                {filteredLines.map((line, i) => (
                  <ClaimLine
                    key={line.id}
                    line={line}
                    rowIndex={i}
                    isDraft={isDraft}
                    canWrite={canWrite}
                    unitPrice={unitPriceByItem.get(line.itemId) ?? null}
                    proposedClaim={proposedByItem.get(line.itemId)}
                    expanded={expandedId === line.id}
                    onToggleExpand={() => setExpandedId((cur) => (cur === line.id ? null : line.id))}
                    onChanged={() => void reload()}
                  />
                ))}
              </TBody>
              <tfoot>
                <TR className="border-t-2 border-nc-border bg-nc-secondary font-semibold">
                  <TD colSpan={3} align="right">
                    Total
                  </TD>
                  <TD align="right" className="nc-numeric">
                    {fmtRate(filteredValueTotal)}
                  </TD>
                </TR>
              </tfoot>
            </Table>
          )}

          {otherLines.length > 0 && (
            <div className="mt-6">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Lump Sum & Provisional Sum</h2>
              <Table>
                <THead>
                  <TR>
                    <TH>Item</TH>
                    <TH align="right">This period</TH>
                  </TR>
                </THead>
                <TBody>
                  {otherLines.map((line) => (
                    <OtherLine key={line.id} line={line} isDraft={isDraft} canWrite={canWrite} onChanged={() => void reload()} />
                  ))}
                </TBody>
              </Table>
            </div>
          )}

          {canWrite && itemsNotYetAdded.length > 0 && (
            <div className="mt-6 rounded-lg border border-nc-border bg-white p-4">
              <h2 className="mb-3 text-sm font-semibold text-nc-text">Add a line by hand</h2>
              <p className="mb-3 text-xs text-nc-text-muted">For a Lump Sum or Provisional Sum Item, or a unit_price Item this claim was created without (added to the contract afterward).</p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs text-nc-text-muted">
                  Item
                  <Select className="mt-1" value={addItemId} onChange={(e) => setAddItemId(e.target.value)}>
                    <option value="">Select an Item…</option>
                    {itemsNotYetAdded.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.itemNumber} — {i.description}
                      </option>
                    ))}
                  </Select>
                </label>
                {addItemId && (
                  <label className="text-xs text-nc-text-muted">
                    This period
                    <Input className="mt-1" inputMode="decimal" value={addItemValue} onChange={(e) => setAddItemValue(e.target.value)} />
                  </label>
                )}
                <Button type="button" variant="secondary" disabled={!addItemId || addingItem} onClick={() => void handleAddItem()}>
                  {addingItem ? 'Adding…' : 'Add line'}
                </Button>
              </div>
            </div>
          )}

          <div className="mt-8 grid grid-cols-4 gap-4">
            <StatCard label="Gross claim" value={fmtRate(summary?.grossClaim ?? null)} />
            <StatCard label={`Holdback${summary?.holdbackPercent !== null && summary?.holdbackPercent !== undefined ? ` (${summary.holdbackPercent}%)` : ''}`} value={fmtRate(summary?.holdbackAmount ?? null)} />
            <StatCard label={`GST${summary?.gstPercent !== null && summary?.gstPercent !== undefined ? ` (${summary.gstPercent}%)` : ''}`} value={fmtRate(summary?.gstAmount ?? null)} />
            <StatCard label="Amount to invoice" value={fmtRate(summary?.totalInvoiced ?? null)} />
          </div>
          <div className="mt-4">
            <StatCard label="Holdback retained to date" value={fmtRate(retainedToDate)} sub="Earned, and withheld from every progress payment so far — money Keywest has not yet been paid." />
          </div>
        </>
      )}
    </div>
  )
}
