import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconArrowDown, IconArrowUp, IconArrowsSort, IconCurrencyDollar } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { updateTenderPrice, updateCostTrackingEnabled } from '../../lib/supabase/contracts'
import { fetchItems, updateItemAuthorizedValue, updateItemPercentComplete, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, upsertItemPrice, type ItemPrice } from '../../lib/supabase/prices'
import { fetchItemProgressRate } from '../../lib/supabase/monthlyPeriods'
import { fetchViewPreferences, saveViewPreferences } from '../../lib/supabase/viewPreferences'
import { costTrackingVisible, gateOnCostTracking, type CostBasis } from '../../lib/calculations/margin'
import { aggregateFinancials, marginBands, reconcileTenderPrice, rowFinancials, type MarginBand, type RowFinancials } from '../../lib/calculations/bidSummary'
import { measuredRollup, unmeasuredRollup } from '../../lib/calculations/projectedActual'
import { compareItemCodes, sectionLabel, sectionPrefix } from '../../lib/calculations/naturalSort'
import { resolveRatesColumns, type RatesColumnVisibility } from '../../lib/calculations/ratesColumns'
import { errorMessage } from '../../lib/errorMessage'
import { percent, quantity as fmtQuantity, rate } from '../../lib/format'
import { Button, EmptyState, Input, NotificationBanner, PageHeader, SandboxBanner, Select, Spinner, StatCard, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

/** Every field this screen can commit — cost/unitPrice (upserted to item_prices together) plus the two "earned" fields (percentComplete/authorizedValue, written directly to items, one at a time). Cost basis travels with 'cost', not its own field — see changeBasis. */
type EditableField = 'cost' | 'unitPrice' | 'percentComplete' | 'authorizedValue'

interface Draft {
  cost: string
  costBasis: CostBasis
  unitPrice: string
  percentComplete: string
  authorizedValue: string
}

function defaultBasis(item: Item): CostBasis {
  // Lump Sum/Provisional Sum has no quantity to be a rate against — total
  // is the only basis that ever applies, so it's the only one ever offered.
  return item.itemKind === 'unit_price' ? 'per_unit' : 'total'
}

function toDraft(item: Item, price: ItemPrice | undefined): Draft {
  return {
    cost: price?.costPrice?.toString() ?? '',
    costBasis: price?.costBasis ?? defaultBasis(item),
    unitPrice: price?.unitPrice?.toString() ?? '',
    percentComplete: item.percentComplete?.toString() ?? '',
    authorizedValue: item.authorizedValue?.toString() ?? '',
  }
}

function parseRate(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isNaN(n) ? null : n
}

// The draft itself always holds the raw, unformatted digits a person is
// (or just was) typing — parsing and reformatting happen only at display
// time, never written back into the draft, so a focused field can hand
// this straight back unchanged and a blurred one can reformat every
// render without ever fighting the caret mid-keystroke.
function displayValue(raw: string, isFocused: boolean): string {
  if (isFocused) return raw
  const n = parseRate(raw)
  return n === null ? '' : rate(n)
}

// Same discipline as displayValue, but percent_complete is stored 0-100
// (not the 0-1 ratio format.ts's own percent() expects) — a plain
// toFixed avoids reaching for that formatter under a different contract.
function displayPercentValue(raw: string, isFocused: boolean): string {
  if (isFocused) return raw
  const n = parseRate(raw)
  return n === null ? '' : `${n.toFixed(1)}%`
}

function focusCell(row: number, field: EditableField) {
  const el = document.querySelector<HTMLInputElement>(`[data-cell="${row}-${field}"]`)
  el?.focus()
  el?.select()
}

// Every money-ish cell — input, read-only text, or a bare dash for a row
// kind the column doesn't apply to — carries the same py-2 so a row's
// height never depends on which of those three it happens to be this
// render. Matches Input's own vertical padding exactly (FIELD_BASE).
//
// w-full, not a literal pixel width — the actual rendered width of every
// cell in a column is set ONCE, on that column's <TH>, by table-layout:
// fixed. A second, independently-maintained pixel constant here was how
// the extended-amount bar ended up scaled against a number that no longer
// matched the column's real width and bled past the table border: two
// sources of truth for the same measurement, free to drift apart the next
// time either one changes without the other. w-full has exactly one source
// (the TH), so it can't.
function MoneyDisplay({ value }: { value: number | null }) {
  return <span className="nc-numeric inline-block w-full py-2 text-right">{value === null ? '—' : rate(value)}</span>
}
function DashCell({ title }: { title?: string }) {
  return (
    <span className="inline-block w-full py-2 text-right text-nc-text-muted" title={title}>
      —
    </span>
  )
}
// percent_complete's own read-only display — one decimal, stored 0-100 (not
// format.ts's percent(), which expects a 0-1 ratio and would misread this
// value by a factor of 100).
function PercentDisplay({ value }: { value: number | null }) {
  return <span className="nc-numeric inline-block w-full py-2 text-right">{value === null ? '—' : `${value.toFixed(1)}%`}</span>
}

// The Pareto view: a background bar scaled against the largest Ext. amount
// on the contract, the figure layered on top so it stays the primary,
// readable element. Deliberately NOT used for Ext. cost — cost coverage is
// partial and permanent, so a bar chart there would imply a comparability
// the data doesn't have. Anchored to the RIGHT, growing leftward, so it
// always sits directly behind the right-aligned figure it describes.
//
// Positioned relative to the TD itself (each call site below sets
// `relative` on that TD's own className), not an inner wrapper span — a
// wrapper is only ever as tall as its own text content, which sits SHORTER
// than the row the moment a sibling cell (the Item identity column, most
// often, running two lines) is taller: a table row's real rendered height
// is set by its tallest cell, not this one. Anchoring to the TD instead of
// a wrapper guarantees the bar always matches the row's actual height,
// because every cell in a row shares that same height by construction —
// this is what fixes the bar reading as a short, floating block rather
// than filling the row it describes.
//
// `relative` on the number span isn't a positioning offset (it has none) —
// it's what makes the number a POSITIONED sibling too, so painting order
// resolves by DOM order between two positioned elements (number after bar,
// so number paints on top) instead of the default rule that would put the
// bar — position: absolute — above ordinary in-flow content regardless of
// DOM order.
function ExtAmountCell({ value, maxValue }: { value: number | null; maxValue: number }) {
  const pct = value !== null && maxValue > 0 && value > 0 ? (value / maxValue) * 100 : 0
  return (
    <>
      {pct > 0 && <span className="absolute inset-y-0 right-0 rounded-sm bg-nc-accent/15" style={{ width: `${pct}%` }} aria-hidden="true" />}
      <span className="nc-numeric relative block py-2 text-right">{value === null ? '—' : rate(value)}</span>
    </>
  )
}

const BAND_TONE: Record<MarginBand, string> = {
  below: 'bg-nc-danger-bg text-nc-danger-text',
  neutral: '',
  above: 'bg-nc-success-bg text-nc-success-text',
}

type SortKey = 'itemNumber' | 'extAmount'

function SortIndicator({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <IconArrowsSort size={13} stroke={1.75} className="inline-block opacity-40" />
  return dir === 'asc' ? <IconArrowUp size={13} stroke={2} className="inline-block" /> : <IconArrowDown size={13} stroke={2} className="inline-block" />
}

interface Row {
  item: Item
  costPrice: number | null
  costBasis: CostBasis | null
  unitPrice: number | null
  /** Recorded quantity to date — unit_price Items only (fetchItemProgressRate's own scope); 0, not absent, for every other kind and for a unit_price Item nothing has been recorded against yet. Feeds measuredRollup's "earned" side and the row panel's own reference line. */
  quantityToDate: number
  financials: RowFinancials
  priced: boolean
}

interface IndexedRow extends Row {
  rowIndex: number
}

// ─────────────────────────────────────────────────────────────────────────
// Column control — Item, Unit price, Extended amount are always on (entry
// needs Unit price; reading needs Extended amount; see resolveRatesColumns'
// own header for why nothing conditions them). Everything else is optional,
// offered here ONLY for columns this seat could see anyway — rights filter
// what the control offers, never the other way around (redesign §3).
// ─────────────────────────────────────────────────────────────────────────

type ColumnKey = keyof RatesColumnVisibility

const COLUMN_LABEL: Record<ColumnKey, string> = {
  unitCost: 'Unit cost',
  extCost: 'Extended cost',
  margin: 'Margin',
  marginPercent: 'Margin %',
  percentComplete: '% complete',
  authorizedValue: 'Authorized value',
}

function ColumnsControl({ columns, costVisible, onToggle }: { columns: RatesColumnVisibility; costVisible: boolean; onToggle: (key: ColumnKey) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  const keys: ColumnKey[] = costVisible
    ? ['unitCost', 'extCost', 'margin', 'marginPercent', 'percentComplete', 'authorizedValue']
    : ['percentComplete', 'authorizedValue']

  return (
    <div className="relative" ref={ref}>
      <Button type="button" variant="secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="true">
        Columns
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-nc-border bg-white p-2 shadow-lg">
          <p className="px-2 pb-1.5 pt-1 text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Columns</p>
          {keys.map((key) => (
            <label key={key} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-nc-text hover:bg-nc-secondary">
              <input type="checkbox" checked={columns[key]} onChange={() => onToggle(key)} className="h-4 w-4 rounded border-nc-border" />
              {COLUMN_LABEL[key]}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

const PREFS_SCOPE = 'rates_columns'

/**
 * Item identity — description and item number, nothing else. Unit of
 * measure and Approximate Quantity used to live on this line; both moved
 * to their own column (see QuantityCell) once that column existed to hold
 * them — the unit qualifies the quantity figure, so it belongs beside that
 * number once a number is on screen, not off in a second location a reader
 * has to cross-reference (add-quantity-column follow-up).
 *
 * Truncates to w-full, not a pixel constant — this is the flexible column
 * (see COL_W's own comment), so its real width moves with the viewport and
 * the active column set; a fixed max-width here would either clip early on
 * a wide screen or, worse, silently stop matching what table-layout: fixed
 * actually rendered.
 *
 * A Lump Sum/Provisional Sum Item still gets its kind tag here — the one
 * thing about an Item's identity that isn't a quantity or a unit, and the
 * one place left that says "no rate applies here" without a reader having
 * to first notice an em-dash in the quantity column.
 */
function ItemIdentity({ item }: { item: Item }) {
  return (
    <div>
      <div className="w-full truncate text-sm text-nc-text" title={item.description}>
        {item.description}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-nc-text-muted">
        <span>{item.itemNumber}</span>
        {item.itemKind !== 'unit_price' && (
          <span className="inline-flex items-center rounded-full bg-nc-neutral-bg px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-nc-neutral-text">
            {item.itemKind === 'lump_sum' ? 'Lump sum' : 'Provisional sum'}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Approximate quantity — the multiplicand that used to live only in the
 * identity line, now its own column so Extended amount (quantity × Unit
 * price) reads across the row instead of requiring a lookup two columns
 * away. Unit of measure sits right beside the figure it qualifies, muted
 * so the number stays the primary read. Lump Sum/Provisional Sum Items
 * have no meaningful quantity — em-dash, never 0 or 1 (a real recorded
 * zero and "doesn't apply" must never look the same).
 */
function QuantityCell({ item }: { item: Item }) {
  if (item.itemKind !== 'unit_price') return <DashCell />
  return (
    <span className="inline-block w-full py-2 text-right">
      <span className="nc-numeric">{fmtQuantity(item.approximateQuantity)}</span> <span className="text-xs text-nc-text-muted">{item.unit}</span>
    </span>
  )
}

export function RatesScreen() {
  const contract = useOutletContext<MyContract>()
  // view_rates alone reaches this screen — a finance-only seat (view_rates
  // without set_cost/set_unit_price) needs exactly that: see the rates,
  // change nothing. The screen isn't hidden for that seat; the inputs
  // render as plain text instead (see canEdit below). Per 0008's UI-gating
  // rule: UI gates are a courtesy, not enforcement — the RLS policies are
  // what actually block the write either way.
  const canEdit = contract.setCost && contract.setUnitPrice
  const costVisible = costTrackingVisible({ costTrackingEnabled: contract.costTrackingEnabled, setCost: contract.setCost })

  const [columns, setColumns] = useState<RatesColumnVisibility>(resolveRatesColumns(null, costVisible, contract.costTrackingEnabled))
  const columnsLoaded = useRef(false)
  // The seat's own saved choices, one key at a time — a key genuinely
  // absent means "never touched," not "off" (resolveRatesColumns' own per-
  // field fallback). This has to be the source resolveRatesColumns is
  // recomputed from on every dependency change; re-feeding the previous
  // COMPUTED booleans back in as if they were all explicit saved choices
  // would silently freeze every column at whatever it happened to render
  // as, defeating the "never touched" fallback the first time cost
  // visibility or the contract's own toggle changed.
  const rawPrefs = useRef<Record<string, unknown> | null>(null)
  const lastPersistedColumns = useRef<string>('{}')

  useEffect(() => {
    fetchViewPreferences(PREFS_SCOPE)
      .then((raw) => {
        rawPrefs.current = raw
        lastPersistedColumns.current = JSON.stringify(raw ?? {})
        setColumns(resolveRatesColumns(raw, costVisible, contract.costTrackingEnabled))
      })
      .catch(() => {
        rawPrefs.current = null
        setColumns(resolveRatesColumns(null, costVisible, contract.costTrackingEnabled))
      })
      .finally(() => {
        columnsLoaded.current = true
      })
    // Re-resolves (not re-fetches) whenever cost visibility or the
    // contract's own cost-tracking setting changes, so a right revoked or
    // a toggle flipped mid-session takes effect without a reload —
    // fetchViewPreferences itself only needs to run once per screen visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract.id])

  useEffect(() => {
    if (!columnsLoaded.current) return
    setColumns(resolveRatesColumns(rawPrefs.current, costVisible, contract.costTrackingEnabled))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [costVisible, contract.costTrackingEnabled])

  // A delta merge onto the saved blob — only the key actually clicked
  // becomes explicit; every other column keeps following the computed
  // default going forward, exactly as if this person had never touched it.
  function toggleColumn(key: ColumnKey) {
    const nextRaw = { ...(rawPrefs.current ?? {}), [key]: !columns[key] }
    rawPrefs.current = nextRaw
    setColumns(resolveRatesColumns(nextRaw, costVisible, contract.costTrackingEnabled))
    const serialized = JSON.stringify(nextRaw)
    if (columnsLoaded.current && serialized !== lastPersistedColumns.current) {
      void saveViewPreferences(PREFS_SCOPE, nextRaw).then(() => {
        lastPersistedColumns.current = serialized
      })
    }
  }

  const [items, setItems] = useState<Item[]>([])
  const [prices, setPrices] = useState<Map<string, ItemPrice>>(new Map())
  const [quantityByItem, setQuantityByItem] = useState<Map<string, number>>(new Map())
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map())
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  // Every cell whose last write attempt failed, keyed `${itemId}:${field}` —
  // not just the most recent one. Enter never waits for a commit to resolve
  // before moving on (a 48-row pass has to stay fast), which means a
  // failure can land several rows behind wherever the person's focus
  // already is by the time it's known. This has to survive past that
  // moment, not just flash where the failure happened — cleared only when
  // a later write for that exact cell succeeds, never on a timer, never by
  // scrolling past it.
  const [failedCells, setFailedCells] = useState<Map<string, string>>(new Map())

  function markFailed(itemId: string, field: EditableField, message: string) {
    setFailedCells((prev) => new Map(prev).set(`${itemId}:${field}`, message))
    // A panel-only field (percentComplete/authorizedValue, or a basis
    // change folded into 'cost') failing where the person can't see it
    // is worse than a column failing in view — open the row so the
    // message is immediately visible, not just counted in the banner.
    if (field === 'percentComplete' || field === 'authorizedValue') setExpandedId(itemId)
  }
  function clearFailed(itemId: string, field: EditableField) {
    setFailedCells((prev) => {
      const key = `${itemId}:${field}`
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.delete(key)
      return next
    })
  }
  // Rows, not cells — two failed fields on the same Item is one row to go
  // fix, not two.
  const failedItemIds = useMemo(() => new Set([...failedCells.keys()].map((k) => k.split(':')[0])), [failedCells])

  // Which item's cost field currently has focus — decides whether it shows
  // raw digits (focused) or a formatted value (not). The basis picker no
  // longer lives beside this field (it moved to the row panel — see §4 of
  // the redesign brief), so this is just per-field focus now, not a group.
  const [focusedCell, setFocusedCell] = useState<{ itemId: string; field: EditableField } | null>(null)

  // One row's panel open at a time — the row being worked on must not move
  // when its panel opens (redesign §4, same rule as the progress claim
  // screen's expand-in-place panel).
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Item # ascending — Schedule 7 order, the order of the tender document
  // being transcribed from — stays the default. Extended amount descending
  // is the margin-review view (§6), where five Items can carry half the
  // contract's value.
  const [sortKey, setSortKey] = useState<SortKey>('itemNumber')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  // The reconciliation figure — entered once from the award document, by a
  // person, never derived from the sum it's checked against (that would
  // make the check tautological). Mirrored into local state so a save
  // reflects immediately without needing the outer contract fetch (Sidebar's
  // own) to re-run; re-synced only when the CONTRACT identity changes, not
  // on every render, so an in-page save is never clobbered by its own effect.
  const [tenderPrice, setTenderPrice] = useState<number | null>(contract.tenderPrice)
  useEffect(() => setTenderPrice(contract.tenderPrice), [contract.id, contract.tenderPrice])
  const [tenderPriceDraft, setTenderPriceDraft] = useState(contract.tenderPrice === null ? '' : contract.tenderPrice.toString())
  const [tenderPriceFocused, setTenderPriceFocused] = useState(false)
  const [tenderPriceSaving, setTenderPriceSaving] = useState(false)
  const [tenderPriceError, setTenderPriceError] = useState<string | null>(null)

  // Whether Margin/Est. cost render anywhere outside this screen's own
  // entry columns — mirrored into local state for the same reason
  // tenderPrice is: a toggle here reflects immediately without waiting on
  // Sidebar's own outer contract fetch to re-run.
  const [costTrackingEnabled, setCostTrackingEnabled] = useState(contract.costTrackingEnabled)
  useEffect(() => setCostTrackingEnabled(contract.costTrackingEnabled), [contract.id, contract.costTrackingEnabled])
  const [costTrackingSaving, setCostTrackingSaving] = useState(false)
  const [costTrackingError, setCostTrackingError] = useState<string | null>(null)

  async function toggleCostTracking() {
    setCostTrackingSaving(true)
    setCostTrackingError(null)
    try {
      await updateCostTrackingEnabled(contract.id, !costTrackingEnabled)
      setCostTrackingEnabled((v) => !v)
    } catch (err) {
      setCostTrackingError(errorMessage(err))
    } finally {
      setCostTrackingSaving(false)
    }
  }

  useEffect(() => {
    setStatus('loading')
    // fetchItemProgressRate is scoped to unit_price Items only (v_item_
    // progress_rate's own WHERE clause) and carries no money — no
    // view_rates gate needed for this leg of the fetch, same posture as
    // the Tracker screens already reading it.
    Promise.all([fetchItems(contract.id), fetchItemPrices(contract.id), fetchItemProgressRate(contract.id)])
      .then(([itemRows, priceRows, progressRows]) => {
        setItems(itemRows)
        const priceMap = new Map(priceRows.map((p) => [p.itemId, p]))
        setPrices(priceMap)
        setQuantityByItem(new Map(progressRows.map((p) => [p.itemId, p.quantityToDate])))
        setDrafts(new Map(itemRows.map((item) => [item.id, toDraft(item, priceMap.get(item.id))])))
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [contract.id])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'itemNumber' ? 'asc' : 'desc')
    }
  }

  const enrichedRows = useMemo<Row[]>(
    () =>
      items.map((item) => {
        const price = prices.get(item.id)
        const costPrice = price?.costPrice ?? null
        const costBasis = price?.costBasis ?? null
        const unitPrice = price?.unitPrice ?? null
        const rawFinancials = rowFinancials({
          itemKind: item.itemKind,
          approximateQuantity: item.approximateQuantity,
          provisionalSum: item.provisionalSum,
          costPrice,
          costBasis,
          unitPrice,
        })
        // Margin/Margin % are suppressed until cost tracking is deliberately
        // turned on, OR shown regardless to the set_cost holder typing the
        // figures in — the same exemption v_item_prices_visible already
        // makes at the database layer, checked here the same way so Margin
        // doesn't read absent right next to a real Unit cost/Ext cost for
        // that exact seat. Nulled here, at the one place every row's
        // financials are built, rather than at each render site.
        const financials = {
          ...rawFinancials,
          tenderedMargin: gateOnCostTracking(rawFinancials.tenderedMargin, costVisible),
          tenderedMarginPercent: gateOnCostTracking(rawFinancials.tenderedMarginPercent, costVisible),
        }
        // A Provisional Sum Item is "priced" the moment Schedule 7's own
        // allowance is on the Item — nothing is ever entered for it here.
        // Every other kind is priced once both its extended figures are
        // known (margin needs both).
        const priced = item.itemKind === 'provisional_sum' ? item.provisionalSum !== null : financials.extCost !== null && financials.extAmount !== null
        return { item, costPrice, costBasis, unitPrice, quantityToDate: quantityByItem.get(item.id) ?? 0, financials, priced }
      }),
    [items, prices, quantityByItem, costVisible],
  )

  const rows = useMemo<IndexedRow[]>(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    const sorted = [...enrichedRows].sort((a, b) => {
      if (sortKey === 'itemNumber') return compareItemCodes(a.item.itemNumber, b.item.itemNumber) * dir
      // Extended amount descending is the default direction the moment this
      // sort is chosen (see toggleSort) — unpriced rows (null) sort last
      // regardless of direction, never mixed in among real figures.
      const av = a.financials.extAmount
      const bv = b.financials.extAmount
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return (av - bv) * dir
    })
    return sorted.map((r, i) => ({ ...r, rowIndex: i }))
  }, [enrichedRows, sortKey, sortDir])

  const grandTotal = useMemo(() => aggregateFinancials(rows.map((r) => ({ itemKind: r.item.itemKind, financials: r.financials }))), [rows])
  const reconciliation = useMemo(
    () => (tenderPrice !== null && grandTotal.extAmountSum !== null ? reconcileTenderPrice(grandTotal.extAmountSum, tenderPrice) : null),
    [tenderPrice, grandTotal.extAmountSum],
  )

  // Projected versus actual — kept as two separate rollups, never blended
  // into one figure. measured is unit_price only, where Approximate
  // Quantity x Unit Price and recorded quantity x Unit Price are both
  // real; unmeasured is lump_sum + provisional_sum, where there is no
  // quantity to compare against at all.
  const measured = useMemo(
    () =>
      measuredRollup(
        rows.filter((r) => r.item.itemKind === 'unit_price').map((r) => ({ approximateQuantity: r.item.approximateQuantity, quantityToDate: r.quantityToDate, unitPrice: r.unitPrice })),
      ),
    [rows],
  )
  const unmeasured = useMemo(
    () =>
      unmeasuredRollup(
        rows
          .filter((r) => r.item.itemKind !== 'unit_price')
          .map((r) => ({ itemKind: r.item.itemKind, tendered: r.financials.extAmount, percentComplete: r.item.percentComplete, authorizedValue: r.item.authorizedValue })),
      ),
    [rows],
  )

  // Scaled against every row on the contract, not just the currently sorted
  // slice — the bar's meaning ("this Item is N% of the biggest one") has to
  // stay fixed regardless of sort order or which section is being read.
  const maxExtAmount = useMemo(() => rows.reduce((max, r) => Math.max(max, r.financials.extAmount ?? 0), 0), [rows])
  const bandByRowId = useMemo(() => marginBands(rows.map((r) => ({ rowId: r.item.id, marginPercent: r.financials.tenderedMarginPercent }))), [rows])
  const bandsActive = bandByRowId.size > 0

  // Section headers/subtotals only mean anything when the visible order
  // actually groups by section — true under the Item # sort (a section's
  // Items share its leading prefix, so they're already contiguous), not
  // under Ext. amount, where the same header/subtotal would have to
  // reappear every time the interleaving crossed back into a section
  // already shown once.
  const groupBySection = sortKey === 'itemNumber'
  const sectionGroups = useMemo(() => {
    if (!groupBySection) return null
    const groups: { prefix: string; rows: IndexedRow[] }[] = []
    for (const row of rows) {
      const prefix = sectionPrefix(row.item.itemNumber)
      const last = groups[groups.length - 1]
      if (last && last.prefix === prefix) last.rows.push(row)
      else groups.push({ prefix, rows: [row] })
    }
    return groups
  }, [rows, groupBySection])

  function updateDraft(id: string, field: EditableField, value: string) {
    setDrafts((prev) => {
      const next = new Map(prev)
      const current = next.get(id)
      if (!current) return prev
      next.set(id, { ...current, [field]: value })
      return next
    })
  }

  async function commitRate(item: Item, field: 'cost' | 'unitPrice') {
    const draft = drafts.get(item.id) ?? toDraft(item, undefined)
    const existing = prices.get(item.id)
    const newCost = field === 'cost' ? parseRate(draft.cost) : (existing?.costPrice ?? null)
    const newUnitPrice = field === 'unitPrice' ? parseRate(draft.unitPrice) : (existing?.unitPrice ?? null)
    // Basis travels with cost, never independently — a blank cost clears
    // both together (item_prices_cost_basis_matches_value).
    const newBasis = newCost === null ? null : draft.costBasis
    if (newCost === existing?.costPrice && newBasis === (existing?.costBasis ?? null) && newUnitPrice === existing?.unitPrice) return

    try {
      const saved = await upsertItemPrice({
        itemId: item.id,
        contractId: contract.id,
        costPrice: newCost,
        costBasis: newBasis,
        unitPrice: newUnitPrice,
      })
      setPrices((prev) => new Map(prev).set(item.id, saved))
      setDrafts((prev) => new Map(prev).set(item.id, toDraft(item, saved)))
      clearFailed(item.id, field)
    } catch (err) {
      markFailed(item.id, field, errorMessage(err))
    }
  }

  // Switching basis never silently reinterprets whatever digits are already
  // sitting in the cost field — a total of $80,000 becoming a per-unit rate
  // of $80,000 by one accidental click would be a catastrophic, not a
  // cosmetic, mistake. The committed value (if any) is cleared instead,
  // forcing a deliberate re-entry under the newly chosen basis.
  async function changeBasis(item: Item, newBasis: CostBasis) {
    const existing = prices.get(item.id)
    setDrafts((prev) => new Map(prev).set(item.id, { ...(prev.get(item.id) ?? toDraft(item, existing)), cost: '', costBasis: newBasis }))
    if (existing?.costPrice == null) return
    try {
      const saved = await upsertItemPrice({
        itemId: item.id,
        contractId: contract.id,
        costPrice: null,
        costBasis: null,
        unitPrice: existing.unitPrice,
      })
      setPrices((prev) => new Map(prev).set(item.id, saved))
      clearFailed(item.id, 'cost')
    } catch (err) {
      markFailed(item.id, 'cost', errorMessage(err))
    }
  }

  // Separate from commitRate — a different table (items, not item_prices),
  // a different write per field (percentComplete and authorizedValue are
  // independent, never read back together the way cost/unitPrice/basis
  // are).
  async function commitEarnedField(item: Item, field: 'percentComplete' | 'authorizedValue') {
    const draft = drafts.get(item.id) ?? toDraft(item, undefined)
    const parsed = field === 'percentComplete' ? parseRate(draft.percentComplete) : parseRate(draft.authorizedValue)
    const existing = field === 'percentComplete' ? item.percentComplete : item.authorizedValue
    if (parsed === existing) return
    try {
      if (field === 'percentComplete') await updateItemPercentComplete(item.id, parsed)
      else await updateItemAuthorizedValue(item.id, parsed)
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, [field]: parsed } : i)))
      clearFailed(item.id, field)
    } catch (err) {
      markFailed(item.id, field, errorMessage(err))
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>, item: Item, field: 'cost' | 'unitPrice', rowIndex: number) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    void commitRate(item, field).then(() => {
      if (rowIndex + 1 < rows.length) focusCell(rowIndex + 1, field)
    })
  }

  // First failed cell in the CURRENT visible order, not failure order — the
  // person reading "3 rows didn't save" is about to work top-down through
  // whatever's on screen right now, same as any other pass over this table.
  // percentComplete/authorizedValue no longer have a column input to focus
  // (they live in the row panel now) — markFailed already opened that row;
  // nothing further to do here for those two fields.
  function focusFirstFailedRow() {
    for (const row of rows) {
      if (failedCells.has(`${row.item.id}:cost`)) return focusCell(row.rowIndex, 'cost')
      if (failedCells.has(`${row.item.id}:unitPrice`)) return focusCell(row.rowIndex, 'unitPrice')
      if (failedCells.has(`${row.item.id}:percentComplete`) || failedCells.has(`${row.item.id}:authorizedValue`)) return setExpandedId(row.item.id)
    }
  }

  async function commitTenderPrice() {
    const parsed = parseRate(tenderPriceDraft)
    if (parsed === tenderPrice) return
    setTenderPriceSaving(true)
    setTenderPriceError(null)
    try {
      await updateTenderPrice(contract.id, parsed)
      setTenderPrice(parsed)
    } catch (err) {
      setTenderPriceError(errorMessage(err))
    } finally {
      setTenderPriceSaving(false)
    }
  }

  const colCount = 4 + (Object.values(columns).filter(Boolean).length)

  // Column-major tab order down whichever price-family columns are actually
  // shown — Unit cost (when visible) fills the first block, Unit price
  // always fills the next. With cost off (the default on both real
  // contracts today) Unit price is the ONLY editable column, so this is
  // exactly "tab down the price column, 48 rows in one pass" — nothing else
  // in the tab sequence to catch on.
  const showUnitCostInput = canEdit && columns.unitCost
  const costTabOffset = 0
  const priceTabOffset = showUnitCostInput ? rows.length : 0

  // width omitted (undefined) for the one column that should flex — see
  // COL_W's own comment. min-w-[200px] is a floor, not a target: only
  // matters if every optional column were ever on at the narrowest desktop
  // width this screen supports, and even then the flexible column measures
  // wider than that in practice (see the redesign follow-up's own measured
  // widths).
  function sortableHeader(key: SortKey, label: string, width: number | undefined, align: 'left' | 'right' = 'left'): ReactNode {
    return (
      <TH
        align={align}
        compact
        style={width === undefined ? undefined : { width }}
        className={`cursor-pointer select-none hover:bg-nc-border/40 ${width === undefined ? 'min-w-[200px]' : ''}`}
        onClick={() => toggleSort(key)}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          <SortIndicator active={sortKey === key} dir={sortDir} />
        </span>
      </TH>
    )
  }

  // Explicit pixel widths for every price-family column — table-layout:
  // fixed makes these authoritative regardless of what any cell's own
  // content wants to claim (a coverage annotation, a long header label, a
  // panel), and every cell inside a column now renders at w-full (see
  // MoneyDisplay/ExtAmountCell/the Input elements below) rather than a
  // second, independently-tracked pixel constant, so there is exactly one
  // place these numbers live.
  //
  // identity has NO width here, deliberately — it's the one column that
  // should absorb whatever space the fixed-width columns don't claim, so
  // the table fills the page at any viewport instead of stopping at the
  // sum of the price columns and leaving a dead gutter. A table with an
  // explicit overall width (below: 100%) and exactly one column left
  // unconstrained is standard fixed-layout behavior, not a special case —
  // the constrained columns keep their pixel caps (never grow, so no
  // overflow risk returns) and identity takes the rest.
  const COL_W = { quantity: 150, unitPrice: 100, extAmount: 120, unitCost: 100, extCost: 120, margin: 110, marginPercent: 85, percentComplete: 95, authorizedValue: 120 }

  function renderPanel(row: IndexedRow): ReactNode {
    const { item } = row
    const draft = drafts.get(item.id) ?? toDraft(item, undefined)
    const percentCompleteFailed = failedCells.get(`${item.id}:percentComplete`)
    const authorizedValueFailed = failedCells.get(`${item.id}:authorizedValue`)
    const costFailed = failedCells.get(`${item.id}:cost`)

    return (
      <TR className="bg-nc-secondary" onClick={(e) => e.stopPropagation()}>
        <TD colSpan={colCount} className="align-top">
          <div className="grid grid-cols-4 gap-6 py-2">
            {item.itemKind === 'unit_price' && (
              <>
                <label className="text-xs text-nc-text-muted">
                  Cost basis
                  {canEdit ? (
                    <Select
                      className="mt-1"
                      tabIndex={-1}
                      aria-label={`${item.itemNumber} cost basis`}
                      value={draft.costBasis}
                      onChange={(e) => void changeBasis(item, e.target.value as CostBasis)}
                    >
                      <option value="per_unit">per unit</option>
                      <option value="total">total</option>
                    </Select>
                  ) : (
                    <div className="mt-1 text-sm text-nc-text">{draft.costBasis === 'total' ? 'total' : 'per unit'}</div>
                  )}
                  {costFailed && <p className="mt-1 text-xs text-nc-danger-text">{costFailed}</p>}
                </label>
                <div className="text-xs text-nc-text-muted">
                  Quantity to date
                  <div className="nc-numeric mt-1 text-sm text-nc-text">{fmtQuantity(row.quantityToDate, item.unit)}</div>
                </div>
              </>
            )}
            {item.itemKind === 'lump_sum' && (
              <label className="text-xs text-nc-text-muted">
                % complete
                {canEdit ? (
                  <Input
                    className="nc-numeric mt-1 text-right"
                    inputMode="decimal"
                    tabIndex={-1}
                    value={displayPercentValue(draft.percentComplete, focusedCell?.itemId === item.id && focusedCell.field === 'percentComplete')}
                    aria-label={`${item.itemNumber} percent complete`}
                    onFocus={() => setFocusedCell({ itemId: item.id, field: 'percentComplete' })}
                    onChange={(e) => updateDraft(item.id, 'percentComplete', e.target.value)}
                    onBlur={() => {
                      setFocusedCell(null)
                      void commitEarnedField(item, 'percentComplete')
                    }}
                  />
                ) : (
                  <div className="nc-numeric mt-1 text-right text-sm text-nc-text">{item.percentComplete === null ? '—' : `${item.percentComplete.toFixed(1)}%`}</div>
                )}
                {percentCompleteFailed && <p className="mt-1 text-xs text-nc-danger-text">{percentCompleteFailed}</p>}
              </label>
            )}
            {item.itemKind === 'provisional_sum' && (
              <label className="text-xs text-nc-text-muted">
                Authorized value
                {canEdit ? (
                  <Input
                    className="nc-numeric mt-1 text-right"
                    inputMode="decimal"
                    tabIndex={-1}
                    value={displayValue(draft.authorizedValue, focusedCell?.itemId === item.id && focusedCell.field === 'authorizedValue')}
                    aria-label={`${item.itemNumber} authorized value`}
                    onFocus={() => setFocusedCell({ itemId: item.id, field: 'authorizedValue' })}
                    onChange={(e) => updateDraft(item.id, 'authorizedValue', e.target.value)}
                    onBlur={() => {
                      setFocusedCell(null)
                      void commitEarnedField(item, 'authorizedValue')
                    }}
                  />
                ) : (
                  <div className="nc-numeric mt-1 text-right text-sm text-nc-text">{rate(item.authorizedValue)}</div>
                )}
                {authorizedValueFailed && <p className="mt-1 text-xs text-nc-danger-text">{authorizedValueFailed}</p>}
              </label>
            )}
          </div>
        </TD>
      </TR>
    )
  }

  // One row's worth of cells — shared by both the grouped-by-section and
  // flat render paths, so the two never drift. Returns a Fragment of ONE OR
  // TWO <TR>s: the row itself, and — when expanded — its own panel directly
  // beneath it, so later rows shift down and the row being worked on never
  // moves (redesign §4).
  function renderDataRow(row: IndexedRow): ReactNode {
    const { item, rowIndex: i } = row
    const draft = drafts.get(item.id) ?? toDraft(item, undefined)
    const costFailed = failedCells.get(`${item.id}:cost`)
    const unitPriceFailed = failedCells.get(`${item.id}:unitPrice`)
    const percentCompleteFailed = failedCells.get(`${item.id}:percentComplete`)
    const authorizedValueFailed = failedCells.get(`${item.id}:authorizedValue`)
    const rowHasFailure = costFailed !== undefined || unitPriceFailed !== undefined || percentCompleteFailed !== undefined || authorizedValueFailed !== undefined
    const expanded = expandedId === item.id

    const costIsFocused = focusedCell?.itemId === item.id && focusedCell.field === 'cost'
    const priceIsFocused = focusedCell?.itemId === item.id && focusedCell.field === 'unitPrice'

    const costInput = (
      <Input
        className={`nc-numeric text-right ${costFailed !== undefined ? 'border-nc-danger-text' : ''}`}
        data-cell={`${i}-cost`}
        tabIndex={costTabOffset + i + 1}
        inputMode="decimal"
        value={displayValue(draft.cost, costIsFocused)}
        placeholder={item.itemKind === 'unit_price' ? 'Unit cost' : 'Ext. cost'}
        aria-label={item.itemKind === 'lump_sum' ? `${item.itemNumber} Ext. cost` : undefined}
        onFocus={() => setFocusedCell({ itemId: item.id, field: 'cost' })}
        onChange={(e) => updateDraft(item.id, 'cost', e.target.value)}
        onKeyDown={(e) => handleKeyDown(e, item, 'cost', i)}
        onBlur={() => {
          setFocusedCell(null)
          void commitRate(item, 'cost')
        }}
      />
    )

    const priceInput = (
      <Input
        className={`nc-numeric text-right ${unitPriceFailed !== undefined ? 'border-nc-danger-text' : ''}`}
        data-cell={`${i}-unitPrice`}
        tabIndex={priceTabOffset + i + 1}
        inputMode="decimal"
        value={displayValue(draft.unitPrice, priceIsFocused)}
        placeholder={item.itemKind === 'unit_price' ? 'Unit price' : 'Ext. amount'}
        aria-label={item.itemKind === 'lump_sum' ? `${item.itemNumber} Ext. amount` : undefined}
        onFocus={() => setFocusedCell({ itemId: item.id, field: 'unitPrice' })}
        onBlur={() => {
          setFocusedCell(null)
          void commitRate(item, 'unitPrice')
        }}
        onChange={(e) => updateDraft(item.id, 'unitPrice', e.target.value)}
        onKeyDown={(e) => handleKeyDown(e, item, 'unitPrice', i)}
      />
    )

    return (
      <Fragment key={item.id}>
        <TR
          className={`cursor-pointer ${rowHasFailure ? 'bg-nc-danger-bg/40' : !row.priced ? 'bg-nc-secondary/60' : 'hover:bg-nc-secondary'}`}
          onClick={() => setExpandedId((cur) => (cur === item.id ? null : item.id))}
        >
          <TD compact className="align-top">
            <ItemIdentity item={item} />
          </TD>

          {/* Approximate quantity — always shown; the multiplicand that
              used to live only in the identity line. Em-dash for Lump
              Sum/Provisional Sum, never 0 (QuantityCell's own rule). */}
          <TD align="right" dense compact className="align-top">
            <QuantityCell item={item} />
          </TD>

          {/* Unit price — always shown; the one input the entry persona
              needs. */}
          <TD align="right" dense compact className="align-top" onClick={(e) => e.stopPropagation()}>
            {item.itemKind === 'unit_price' ? (
              canEdit ? priceInput : <MoneyDisplay value={row.unitPrice} />
            ) : (
              <DashCell title={item.itemKind === 'lump_sum' ? 'No per-unit rate — enter the total under Extended amount' : undefined} />
            )}
            {unitPriceFailed && <p className="mt-1 text-xs text-nc-danger-text">{unitPriceFailed}</p>}
          </TD>

          {/* Extended amount — always shown; derived for Unit Price, IS the
              editable lump sum price for Lump Sum, sourced from Schedule
              7's own Provisional Sum allowance for Provisional Sum.
              `relative` here (not on an inner wrapper) is what makes the
              magnitude bar inside ExtAmountCell size itself against the
              row's own rendered height — see that component's comment. */}
          <TD align="right" dense compact className="relative align-top" onClick={(e) => e.stopPropagation()}>
            {item.itemKind === 'lump_sum' ? (
              canEdit ? priceInput : <ExtAmountCell value={row.financials.extAmount} maxValue={maxExtAmount} />
            ) : (
              <ExtAmountCell value={row.financials.extAmount} maxValue={maxExtAmount} />
            )}
          </TD>

          {columns.unitCost && (
            <TD align="right" dense compact className="align-top" onClick={(e) => e.stopPropagation()}>
              {item.itemKind === 'unit_price' ? (
                canEdit ? costInput : <MoneyDisplay value={row.costPrice} />
              ) : (
                <DashCell title={item.itemKind === 'lump_sum' ? 'No per-unit rate — enter the total under Extended cost' : undefined} />
              )}
              {costFailed && <p className="mt-1 text-xs text-nc-danger-text">{costFailed}</p>}
            </TD>
          )}

          {columns.extCost && (
            <TD align="right" dense compact className="align-top" onClick={(e) => e.stopPropagation()}>
              {item.itemKind === 'lump_sum' ? (
                canEdit ? costInput : <MoneyDisplay value={row.financials.extCost} />
              ) : item.itemKind === 'unit_price' ? (
                <MoneyDisplay value={row.financials.extCost} />
              ) : (
                <DashCell />
              )}
            </TD>
          )}

          {/* Margin — MARGIN, NOT MARKUP: of revenue (Ext. amount), never
              of cost. Never computed for Provisional Sum — em-dash, never 0. */}
          {columns.margin && (
            <TD align="right" compact className={`nc-numeric align-top ${row.financials.tenderedMargin !== null && row.financials.tenderedMargin < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
              {row.financials.tenderedMargin === null ? '—' : rate(row.financials.tenderedMargin)}
            </TD>
          )}
          {columns.marginPercent && (
            <TD
              align="right"
              compact
              className={`nc-numeric align-top ${
                row.financials.tenderedMarginPercent !== null && row.financials.tenderedMarginPercent < 0
                  ? 'font-semibold bg-nc-danger-bg text-nc-danger-text'
                  : BAND_TONE[bandByRowId.get(item.id) ?? 'neutral']
              }`}
              title={
                bandByRowId.has(item.id)
                  ? `${bandByRowId.get(item.id) === 'below' ? 'Bottom' : bandByRowId.get(item.id) === 'above' ? 'Top' : 'Middle'} third of this contract's own priced Items — relative, not a fixed threshold.`
                  : undefined
              }
            >
              {row.financials.tenderedMarginPercent === null ? '—' : percent(row.financials.tenderedMarginPercent)}
            </TD>
          )}

          {/* % complete/Authorized value — read-only here; editing lives in
              the row's own panel (redesign §4). */}
          {columns.percentComplete && (
            <TD align="right" compact className="align-top">
              {item.itemKind === 'lump_sum' ? <PercentDisplay value={item.percentComplete} /> : <DashCell />}
            </TD>
          )}
          {columns.authorizedValue && (
            <TD align="right" compact className="align-top">
              {item.itemKind === 'provisional_sum' ? <MoneyDisplay value={item.authorizedValue} /> : <DashCell />}
            </TD>
          )}
        </TR>
        {expanded && renderPanel(row)}
      </Fragment>
    )
  }

  function renderSubtotalRow(label: string, rowsInGroup: IndexedRow[], key: string): ReactNode {
    const agg = aggregateFinancials(rowsInGroup.map((r) => ({ itemKind: r.item.itemKind, financials: r.financials })))
    return (
      <TR key={key} className="bg-nc-secondary font-semibold">
        <TD colSpan={3} compact className="text-data align-middle text-nc-text">
          {label}
        </TD>
        <TD align="right" compact className="nc-numeric align-middle">
          {agg.extAmountSum === null ? '—' : rate(agg.extAmountSum)}
        </TD>
        {columns.unitCost && <TD compact />}
        {columns.extCost && (
          <TD align="right" compact className="nc-numeric align-middle">
            {agg.extCostSum === null ? '—' : rate(agg.extCostSum)}
            {costTrackingEnabled && agg.costCoverage.total > 0 && (
              <span className="ml-1.5 text-xs font-normal text-nc-text-muted">
                covers {agg.costCoverage.count} of {agg.costCoverage.total}
              </span>
            )}
          </TD>
        )}
        {columns.margin && (
          <TD align="right" compact className={`nc-numeric align-middle ${agg.tenderedMarginSum !== null && agg.tenderedMarginSum < 0 ? 'text-nc-danger-text' : ''}`}>
            {agg.tenderedMarginSum === null ? '—' : rate(agg.tenderedMarginSum)}
            {costTrackingEnabled && agg.tenderedMarginCoverage.total > 0 && (
              <span className="ml-1.5 text-xs font-normal text-nc-text-muted">
                covers {agg.tenderedMarginCoverage.count} of {agg.tenderedMarginCoverage.total}
              </span>
            )}
          </TD>
        )}
        {columns.marginPercent && (
          <TD align="right" compact className={`nc-numeric align-middle ${agg.tenderedMarginPercent !== null && agg.tenderedMarginPercent < 0 ? 'text-nc-danger-text' : ''}`}>
            {agg.tenderedMarginPercent === null ? '—' : percent(agg.tenderedMarginPercent)}
          </TD>
        )}
        {/* % complete/Authorized value have no meaningful section subtotal —
            a summed percent is meaningless; a summed authorized value would
            just restate part of the projected-versus-actual block below —
            left blank rather than inventing a number nobody asked for. */}
        {columns.percentComplete && <TD compact />}
        {columns.authorizedValue && <TD compact />}
      </TR>
    )
  }

  const subtitle = `${contract.name}${status === 'ready' ? ` · ${rows.length} Items` : ''}`

  return (
    <div>
      <PageHeader
        title="Rates"
        subtitle={subtitle}
        actions={
          contract.viewRates && status === 'ready' && rows.length > 0 ? <ColumnsControl columns={columns} costVisible={costVisible} onToggle={toggleColumn} /> : undefined
        }
      />

      <SandboxBanner contract={contract} />

      {!contract.viewRates ? (
        <EmptyState title="You don't have permission to view rates on this contract." />
      ) : (
        <>
          {costTrackingEnabled && (
            <NotificationBanner tone="info" className="mb-4">
              Cost and margin below are Keywest's own bid estimate, entered on this screen — actual cost isn't recorded in NovaCore yet.
            </NotificationBanner>
          )}

          {/* The cost-tracking switch itself — the one control that decides
              whether tendered margin/Est. cost render anywhere on this
              contract outside the entry columns just below, for seats who
              don't hold the cost-entry rights. canEdit itself requires
              set_cost, so everyone who sees this banner ALREADY sees real
              cost/margin regardless of the toggle (the entry-surface
              exemption) — the copy below has to say that plainly. */}
          {canEdit && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-nc-border bg-white px-4 py-3">
              <div>
                <p className="text-sm font-medium text-nc-text">Cost tracking is {costTrackingEnabled ? 'on' : 'off'} for this contract.</p>
                <p className="text-xs text-nc-text-muted">
                  {costTrackingEnabled
                    ? 'Tendered margin and Est. cost figures show here and elsewhere in NovaCore, computed from the costs entered below.'
                    : 'Unit cost, Ext. cost, and tendered margin stay visible to you as the person entering them — here and everywhere else in NovaCore. They stay hidden from every other seat until this is turned on.'}
                </p>
                {costTrackingError && <p className="mt-1 text-xs text-nc-danger-text">{costTrackingError}</p>}
              </div>
              <Button type="button" variant="secondary" disabled={costTrackingSaving} onClick={() => void toggleCostTracking()}>
                {costTrackingSaving ? 'Saving…' : costTrackingEnabled ? 'Turn off cost tracking' : 'Turn on cost tracking'}
              </Button>
            </div>
          )}
          {/* A full-width block for "nothing here is editable" outweighs
              what it's saying — on a screen where NOTHING can be typed
              into, this is a standing fact, not a status update, the same
              category the sandbox banner's own 'quiet' variant exists for
              (see that component's comment). Still unmissable, no longer
              competing with the numbers for attention. */}
          {!canEdit && (
            <p className="mb-4 inline-flex max-w-full items-center gap-1.5 rounded-md bg-nc-info-bg px-2.5 py-1 text-xs text-nc-info-text">
              Read-only for you on this contract — ask whoever manages rights here if you need to enter figures.
            </p>
          )}
          {bandsActive && columns.marginPercent && (
            <NotificationBanner tone="info" className="mb-4">
              Margin % below is banded against the bottom/top third of this contract's own priced Items — relative to {contract.name}, not a fixed threshold. Rows with no cost show no band.
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
            (rows.length === 0 ? (
              <EmptyState icon={<IconCurrencyDollar size={32} stroke={1.5} />} title="No items to price yet." description="Add items on the Items screen first." />
            ) : (
              <>
                <Table maxHeight="calc(100vh - 280px)" style={{ tableLayout: 'fixed', width: '100%' }}>
                  <THead className="sticky top-0 z-10">
                    {failedItemIds.size > 0 && (
                      <tr>
                        <th colSpan={colCount} className="bg-nc-danger-bg p-0 text-left">
                          <button type="button" onClick={focusFirstFailedRow} className="w-full px-4 py-2 text-left text-sm font-semibold text-nc-danger-text hover:bg-nc-danger-bg/70">
                            {failedItemIds.size} row{failedItemIds.size === 1 ? '' : 's'} didn't save — click to go to the first one
                          </button>
                        </th>
                      </tr>
                    )}
                    <TR>
                      {sortableHeader('itemNumber', 'Item', undefined)}
                      <TH align="right" compact style={{ width: COL_W.quantity }}>
                        Approximate quantity
                      </TH>
                      <TH align="right" compact style={{ width: COL_W.unitPrice }}>
                        Unit price
                      </TH>
                      {sortableHeader('extAmount', 'Extended amount', COL_W.extAmount, 'right')}
                      {columns.unitCost && (
                        <TH align="right" compact style={{ width: COL_W.unitCost }}>
                          Unit cost
                        </TH>
                      )}
                      {columns.extCost && (
                        <TH align="right" compact style={{ width: COL_W.extCost }}>
                          Extended cost
                        </TH>
                      )}
                      {columns.margin && (
                        <TH align="right" compact style={{ width: COL_W.margin }} title="Tendered margin — at Approximate Quantity, the whole scope as bid, not quantity to date">
                          Margin
                        </TH>
                      )}
                      {columns.marginPercent && (
                        <TH
                          align="right"
                          compact
                          style={{ width: COL_W.marginPercent }}
                          title="Tendered margin — at Approximate Quantity, the whole scope as bid, not quantity to date"
                        >
                          Margin %
                        </TH>
                      )}
                      {columns.percentComplete && (
                        <TH align="right" compact style={{ width: COL_W.percentComplete }}>
                          % complete
                        </TH>
                      )}
                      {columns.authorizedValue && (
                        <TH align="right" compact style={{ width: COL_W.authorizedValue }}>
                          Authorized value
                        </TH>
                      )}
                    </TR>
                  </THead>
                  <TBody>
                    {groupBySection && sectionGroups
                      ? sectionGroups.map((group) => (
                          <Fragment key={group.prefix}>
                            <TR>
                              <TD colSpan={colCount} className="border-t border-nc-border text-xs font-semibold uppercase tracking-wide text-nc-text-muted first:border-t-0">
                                {sectionLabel(group.prefix)}
                              </TD>
                            </TR>
                            {group.rows.map((row) => renderDataRow(row))}
                            {renderSubtotalRow(`${sectionLabel(group.prefix)} subtotal`, group.rows, group.prefix)}
                          </Fragment>
                        ))
                      : rows.map((row) => renderDataRow(row))}
                  </TBody>
                </Table>

                {/* Totals as cards, not a footer row — the answer, not a
                    footnote (redesign §5). Section subtotals stay inside
                    the table above; only the grand total moves down here. */}
                <div className={`mt-6 grid gap-4 ${costVisible ? 'grid-cols-3' : 'grid-cols-1'}`}>
                  <StatCard
                    label="Contract value"
                    value={grandTotal.extAmountSum === null ? '—' : rate(grandTotal.extAmountSum)}
                    sub={
                      <div className="space-y-2">
                        {tenderPrice !== null && reconciliation ? (
                          reconciliation.matches ? (
                            <span className="text-nc-success-text">Matches the tendered price of {rate(tenderPrice)}.</span>
                          ) : (
                            <span>
                              {rate(Math.abs(reconciliation.differenceCents) / 100)} {reconciliation.differenceCents > 0 ? 'over' : 'under'} the tendered price of {rate(tenderPrice)}.
                            </span>
                          )
                        ) : (
                          <span>No tender price on file to verify against.</span>
                        )}
                        {canEdit && (
                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              className="nc-numeric text-right"
                              style={{ width: 140 }}
                              inputMode="decimal"
                              placeholder="Tender price"
                              aria-label="Tender price"
                              value={tenderPriceFocused ? tenderPriceDraft : displayValue(tenderPriceDraft, false)}
                              onFocus={() => setTenderPriceFocused(true)}
                              onChange={(e) => setTenderPriceDraft(e.target.value)}
                              onBlur={() => {
                                setTenderPriceFocused(false)
                                void commitTenderPrice()
                              }}
                              onKeyDown={(e) => {
                                if (e.key !== 'Enter') return
                                e.preventDefault()
                                e.currentTarget.blur()
                              }}
                            />
                            {tenderPriceSaving && <Spinner />}
                            {tenderPriceError && <span className="text-xs text-nc-danger-text">{tenderPriceError}</span>}
                          </div>
                        )}
                      </div>
                    }
                  />
                  {costVisible && (
                    <StatCard
                      label="Estimated cost"
                      value={grandTotal.extCostSum === null ? '—' : rate(grandTotal.extCostSum)}
                      sub={costTrackingEnabled && grandTotal.costCoverage.total > 0 ? `Covers ${grandTotal.costCoverage.count} of ${grandTotal.costCoverage.total} items.` : undefined}
                    />
                  )}
                  {costVisible && (
                    <StatCard
                      label="Margin"
                      value={grandTotal.tenderedMarginSum === null ? '—' : rate(grandTotal.tenderedMarginSum)}
                      sub={
                        <>
                          {grandTotal.tenderedMarginPercent !== null && <span>{percent(grandTotal.tenderedMarginPercent)} of revenue. </span>}
                          {costTrackingEnabled && grandTotal.tenderedMarginCoverage.total > 0 && (
                            <span>
                              Covers {grandTotal.tenderedMarginCoverage.count} of {grandTotal.tenderedMarginCoverage.total} items.
                            </span>
                          )}
                        </>
                      }
                    />
                  )}
                </div>

                {/* Projected versus actual — beside the cards, never merged
                    with the reconciliation or with each other: two separate
                    figures, side by side, because blending them (a
                    quantity-weighted completion percentage) has been tried
                    and removed from this product twice. Shown regardless of
                    canEdit — this is a read of what's already on file. */}
                <div className="mt-4 rounded-lg border border-nc-border bg-white px-4 py-3">
                  <div className="grid grid-cols-2 gap-8 text-sm">
                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Quantity-measured — Unit Price Items</p>
                      <p className="text-nc-text">
                        Projected <span className="nc-numeric font-semibold">{measured.projected === null ? '—' : rate(measured.projected)}</span>
                        {' · '}
                        Earned <span className="nc-numeric font-semibold">{measured.earned === null ? '—' : rate(measured.earned)}</span>
                        {measured.percent !== null && (
                          <span
                            className={`nc-numeric ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${
                              measured.percent > 1 ? 'bg-nc-over-bg text-nc-over-text' : 'bg-nc-secondary text-nc-text-muted'
                            }`}
                            title={measured.percent > 1 ? 'Earned above projected — recorded beyond Approximate Quantity, revenue above tender, not a fault.' : undefined}
                          >
                            {percent(measured.percent)}
                          </span>
                        )}
                      </p>
                      {measured.coverage.total > 0 && measured.coverage.count < measured.coverage.total && (
                        <p className="mt-1 text-xs text-nc-text-muted">Covers {measured.coverage.count} of {measured.coverage.total} items — the rest have no Unit price on file yet.</p>
                      )}
                    </div>
                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Not quantity-measured — Lump Sum &amp; Provisional Sum Items</p>
                      <p className="text-nc-text">
                        Tendered <span className="nc-numeric font-semibold">{unmeasured.tendered === null ? '—' : rate(unmeasured.tendered)}</span>
                        {' · '}
                        Earned <span className="nc-numeric font-semibold">{unmeasured.earned === null ? '—' : rate(unmeasured.earned)}</span>
                      </p>
                      {unmeasured.coverage.total > 0 && unmeasured.coverage.count < unmeasured.coverage.total && (
                        <p className="mt-1 text-xs text-nc-text-muted">Covers {unmeasured.coverage.count} of {unmeasured.coverage.total} items — the rest have nothing recorded as earned yet.</p>
                      )}
                    </div>
                  </div>
                </div>
              </>
            ))}
        </>
      )}
    </div>
  )
}
