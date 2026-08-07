import { Fragment, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconArrowDown, IconArrowUp, IconArrowsSort, IconCurrencyDollar } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { updateTenderPrice, updateCostTrackingEnabled } from '../../lib/supabase/contracts'
import { fetchItems, updateItemAuthorizedValue, updateItemPercentComplete, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, upsertItemPrice, type ItemPrice } from '../../lib/supabase/prices'
import { fetchItemProgressRate } from '../../lib/supabase/monthlyPeriods'
import type { CostBasis } from '../../lib/calculations/margin'
import { aggregateFinancials, marginBands, reconcileTenderPrice, rowFinancials, type MarginBand, type RowFinancials } from '../../lib/calculations/bidSummary'
import { measuredRollup, unmeasuredRollup } from '../../lib/calculations/projectedActual'
import { compareItemCodes, sectionLabel, sectionPrefix } from '../../lib/calculations/naturalSort'
import { errorMessage } from '../../lib/errorMessage'
import { percent, quantity as fmtQuantity, rate } from '../../lib/format'
import { Button, EmptyState, Input, NotificationBanner, PageHeader, SandboxBanner, Select, Spinner, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

const FULL_COL_COUNT = 11
const CORE_COL_COUNT = 9

/** Every field this screen can commit — the original two (cost/unitPrice, upserted to item_prices together) plus the two "earned" fields added for projected-versus-actual (percentComplete/authorizedValue, written directly to items, one at a time, independently of each other and of cost/unitPrice). */
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
function MoneyDisplay({ value, width }: { value: number | null; width: number }) {
  return (
    <span className="nc-numeric inline-block py-2 text-right" style={{ width }}>
      {value === null ? '—' : rate(value)}
    </span>
  )
}
function DashCell({ width, title }: { width: number; title?: string }) {
  return (
    <span className="inline-block py-2 text-right text-nc-text-muted" style={{ width }} title={title}>
      —
    </span>
  )
}
// percent_complete's own read-only display — one decimal, stored 0-100 (not
// format.ts's percent(), which expects a 0-1 ratio and would misread this
// value by a factor of 100).
function PercentDisplay({ value, width }: { value: number | null; width: number }) {
  return (
    <span className="nc-numeric inline-block py-2 text-right" style={{ width }}>
      {value === null ? '—' : `${value.toFixed(1)}%`}
    </span>
  )
}

// The Pareto view: a background bar scaled against the largest Ext. amount
// on the contract, the figure layered on top so it stays the primary,
// readable element (the brief's own requirement). Deliberately NOT used for
// Ext. cost — cost coverage is partial and permanent, so a bar chart there
// would imply a comparability the data doesn't have. Anchored to the RIGHT,
// growing leftward, so it always sits directly behind the right-aligned
// figure it describes — anchored left, a small bar's visible edge lands at
// the cell's far side, next to the PREVIOUS column, and reads as belonging
// there instead. No width floor: a true-to-scale sliver for a small-but-real
// figure is the honest signal; a floor made every under-~3% row draw the
// identical width regardless of actual size, which is what turned into the
// stray vertical "column rule" down the table.
function ExtAmountCell({ value, width, maxValue }: { value: number | null; width: number; maxValue: number }) {
  const pct = value !== null && maxValue > 0 && value > 0 ? (value / maxValue) * 100 : 0
  return (
    <span className="relative inline-block py-2" style={{ width }}>
      {pct > 0 && <span className="absolute inset-y-0 right-0 rounded-sm bg-nc-accent/15" style={{ width: `${pct}%` }} aria-hidden="true" />}
      <span className="nc-numeric relative block text-right">{value === null ? '—' : rate(value)}</span>
    </span>
  )
}

const BAND_TONE: Record<MarginBand, string> = {
  below: 'bg-nc-danger-bg text-nc-danger-text',
  neutral: '',
  above: 'bg-nc-success-bg text-nc-success-text',
}

const UNIT_W = 100
const EXT_W = 140

type SortKey = 'itemNumber' | 'quantity' | 'extAmount'

function SortIndicator({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <IconArrowsSort size={13} stroke={1.75} className="inline-block opacity-40" />
  return dir === 'asc' ? <IconArrowUp size={13} stroke={2} className="inline-block" /> : <IconArrowDown size={13} stroke={2} className="inline-block" />
}

interface Row {
  item: Item
  costPrice: number | null
  costBasis: CostBasis | null
  unitPrice: number | null
  /** Recorded quantity to date — unit_price Items only (fetchItemProgressRate's own scope); 0, not absent, for every other kind and for a unit_price Item nothing has been recorded against yet. Feeds measuredRollup's "earned" side. */
  quantityToDate: number
  financials: RowFinancials
  priced: boolean
}

interface IndexedRow extends Row {
  rowIndex: number
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

  // % complete and Authorized value apply to Lump Sum and Provisional Sum
  // Items respectively — on a contract mostly made of Unit Price Items
  // (every real contract so far) they're almost entirely em-dashes, and at
  // eleven columns this table doesn't fit 1440px. Collapsed by default,
  // same "secondary, behind a control" treatment Overview already gives
  // its own optional columns — nothing here is dropped, only hidden until
  // asked for.
  const [showEarnedColumns, setShowEarnedColumns] = useState(false)
  const colCount = showEarnedColumns ? FULL_COL_COUNT : CORE_COL_COUNT

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

  // Which item's cost-family GROUP (the field plus its optional basis
  // selector) currently has focus — never which single element. See the
  // group wrapper below for why: input-focus-alone was the basis-selector
  // bug (fixed separately), and the exact same "focus anywhere in the
  // group" rule now also decides whether the field shows raw digits
  // (focused) or a formatted value (not).
  const [focusedCell, setFocusedCell] = useState<{ itemId: string; field: EditableField } | null>(null)

  // Item # ascending — Schedule 7 order, the order of the tender document
  // being transcribed from — stays the default. Quantity and Ext. amount
  // are both available sorts; Ext. amount descending is the margin-review
  // view (§5), where five Items can carry half the contract's value.
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
  // entry columns (0042) — mirrored into local state for the same reason
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
        // turned on (0042) — Unit cost/Ext. cost stay real regardless, since
        // those are the entry surface itself, not a derived claim. Nulled
        // here, at the one place every row's financials are built, rather
        // than at each render site — every consumer downstream (the row
        // cell, section subtotals, the grand total, the tercile bands) sees
        // "no margin" through the exact same absent-reads-as-em-dash path
        // it already uses for a Provisional Sum row's own null margin.
        const financials = costTrackingEnabled ? rawFinancials : { ...rawFinancials, margin: null, marginPercent: null }
        // A Provisional Sum Item is "priced" the moment Schedule 7's own
        // allowance is on the Item — nothing is ever entered for it here.
        // Every other kind is priced once both its extended figures are
        // known (margin needs both).
        const priced = item.itemKind === 'provisional_sum' ? item.provisionalSum !== null : financials.extCost !== null && financials.extAmount !== null
        return { item, costPrice, costBasis, unitPrice, quantityToDate: quantityByItem.get(item.id) ?? 0, financials, priced }
      }),
    [items, prices, quantityByItem, costTrackingEnabled],
  )

  const rows = useMemo<IndexedRow[]>(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    const sorted = [...enrichedRows].sort((a, b) => {
      if (sortKey === 'itemNumber') return compareItemCodes(a.item.itemNumber, b.item.itemNumber) * dir
      if (sortKey === 'quantity') return (a.item.approximateQuantity - b.item.approximateQuantity) * dir
      // Ext. amount descending is the default direction the moment this
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
  // into one figure (see projectedActual.ts's own header for why). measured
  // is unit_price only, where Approximate Quantity x Unit Price and
  // recorded quantity x Unit Price are both real; unmeasured is lump_sum +
  // provisional_sum, where there is no quantity to compare against at all.
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
  const bandByRowId = useMemo(
    () => marginBands(rows.map((r) => ({ rowId: r.item.id, marginPercent: r.financials.marginPercent }))),
    [rows],
  )
  const bandsActive = bandByRowId.size > 0

  // Section headers/subtotals only mean anything when the visible order
  // actually groups by section — true under the Item # sort (a section's
  // Items share its leading prefix, so they're already contiguous), not
  // under Quantity or Ext. amount, where the same header/subtotal would
  // have to reappear every time the interleaving crossed back into a
  // section already shown once, and a subtotal would mix Items that have
  // nothing to do with each other under a value ranking.
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
    // both together (item_prices_cost_basis_matches_value, 0023).
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
  // are). Shares the same Draft/drafts/failedCells machinery as commitRate
  // rather than duplicating it under a second Map.
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

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>, item: Item, field: EditableField, rowIndex: number) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const commit = field === 'cost' || field === 'unitPrice' ? commitRate(item, field) : commitEarnedField(item, field)
    void commit.then(() => {
      if (rowIndex + 1 < rows.length) focusCell(rowIndex + 1, field)
    })
  }

  // First failed cell in the CURRENT visible order, not failure order — the
  // person reading "3 rows didn't save" is about to work top-down through
  // whatever's on screen right now, same as any other pass over this table.
  function focusFirstFailedRow() {
    for (const row of rows) {
      if (failedCells.has(`${row.item.id}:cost`)) return focusCell(row.rowIndex, 'cost')
      if (failedCells.has(`${row.item.id}:unitPrice`)) return focusCell(row.rowIndex, 'unitPrice')
      if (failedCells.has(`${row.item.id}:percentComplete`)) return focusCell(row.rowIndex, 'percentComplete')
      if (failedCells.has(`${row.item.id}:authorizedValue`)) return focusCell(row.rowIndex, 'authorizedValue')
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

  // Leads with the TRUE total (every row rendered, all three kinds) before
  // the cost-coverage fraction — costCoverage.total is deliberately
  // narrower (unit_price + lump_sum only; a Provisional Sum Item never
  // carries a cost, so it was never a candidate), and showing that number
  // alone read as "the contract has 45 Items," not "45 of them can be
  // costed."
  // The cost-coverage fragment is itself a claim about how much cost data
  // means something — quiet along with margin (0042) rather than reporting
  // a completeness fraction for figures nothing downstream is showing.
  const subtitle = `${contract.name}${status === 'ready' ? ` · ${rows.length} Items${costTrackingEnabled ? ` · ${grandTotal.costCoverage.count} of ${grandTotal.costCoverage.total} have an Est. cost` : ''}` : ''}`

  function sortableHeader(key: SortKey, label: string, align: 'left' | 'right' = 'left'): ReactNode {
    return (
      <TH align={align} compact onClick={() => toggleSort(key)} className="cursor-pointer select-none hover:bg-nc-border/40">
        <span className="inline-flex items-center gap-1">
          {label}
          <SortIndicator active={sortKey === key} dir={sortDir} />
        </span>
      </TH>
    )
  }

  // One row's worth of cells (everything after Item #/Description/
  // Approx. Qty) — shared by both the grouped-by-section and flat render
  // paths below, so the two never drift.
  function renderDataRow(row: IndexedRow): ReactNode {
    const { item, rowIndex: i } = row
    const draft = drafts.get(item.id) ?? toDraft(item, undefined)
    const costFailed = failedCells.get(`${item.id}:cost`)
    const unitPriceFailed = failedCells.get(`${item.id}:unitPrice`)
    const percentCompleteFailed = failedCells.get(`${item.id}:percentComplete`)
    const authorizedValueFailed = failedCells.get(`${item.id}:authorizedValue`)
    const rowHasFailure = costFailed !== undefined || unitPriceFailed !== undefined || percentCompleteFailed !== undefined || authorizedValueFailed !== undefined

    const percentCompleteIsFocused = focusedCell?.itemId === item.id && focusedCell.field === 'percentComplete'
    const authorizedValueIsFocused = focusedCell?.itemId === item.id && focusedCell.field === 'authorizedValue'

    const costIsFocused = focusedCell?.itemId === item.id && focusedCell.field === 'cost'
    const priceIsFocused = focusedCell?.itemId === item.id && focusedCell.field === 'unitPrice'

    // The cost-basis picker only ever applies to a Unit Price Item (Lump
    // Sum/Provisional Sum are always 'total', no toggle offered — 0024).
    // Shown when there's a reason to look at it: focus anywhere in the
    // cost GROUP right now, or already committed as a total.
    const showBasisControl = item.itemKind === 'unit_price' && (costIsFocused || draft.costBasis === 'total')

    const costCommitField = 'cost' as const
    const priceCommitField = 'unitPrice' as const

    const costInput = (
      <Input
        className={`nc-numeric text-right ${costFailed !== undefined ? 'border-nc-danger-text' : ''}`}
        style={{ width: item.itemKind === 'unit_price' ? UNIT_W : EXT_W }}
        data-cell={`${i}-cost`}
        tabIndex={i * 2 + 1}
        inputMode="decimal"
        value={displayValue(draft.cost, costIsFocused)}
        // An empty box with no cue reads as broken next to a genuine em-dash
        // in the same row (Approx. Qty, Unit cost for a Lump Sum Item) —
        // the placeholder is what says "enterable, just not entered yet."
        placeholder={item.itemKind === 'unit_price' ? 'Unit cost' : 'Ext. cost'}
        aria-label={item.itemKind === 'lump_sum' ? `${item.itemNumber} Ext. cost` : undefined}
        onChange={(e) => updateDraft(item.id, costCommitField, e.target.value)}
        onKeyDown={(e) => handleKeyDown(e, item, costCommitField, i)}
        {...(item.itemKind === 'unit_price'
          ? {}
          : {
              onFocus: () => setFocusedCell({ itemId: item.id, field: costCommitField }),
              onBlur: () => {
                setFocusedCell(null)
                void commitRate(item, costCommitField)
              },
            })}
      />
    )

    const priceInput = (
      <Input
        className={`nc-numeric text-right ${unitPriceFailed !== undefined ? 'border-nc-danger-text' : ''}`}
        style={{ width: item.itemKind === 'unit_price' ? UNIT_W + 20 : EXT_W }}
        data-cell={`${i}-unitPrice`}
        tabIndex={rows.length * 2 + i + 1}
        inputMode="decimal"
        value={displayValue(draft.unitPrice, priceIsFocused)}
        placeholder={item.itemKind === 'unit_price' ? 'Unit price' : 'Ext. amount'}
        aria-label={item.itemKind === 'lump_sum' ? `${item.itemNumber} Ext. amount` : undefined}
        onFocus={() => setFocusedCell({ itemId: item.id, field: priceCommitField })}
        onBlur={() => {
          setFocusedCell(null)
          void commitRate(item, priceCommitField)
        }}
        onChange={(e) => updateDraft(item.id, priceCommitField, e.target.value)}
        onKeyDown={(e) => handleKeyDown(e, item, priceCommitField, i)}
      />
    )

    // Column-major tab order, same convention cost/unitPrice already use
    // (fast down-the-column transcription, not left-to-right row order) —
    // these two ranges start after cost's and unitPrice's own ranges end
    // (rows.length*2 for cost+basis, rows.length for unitPrice).
    const percentCompleteInput = (
      <Input
        className={`nc-numeric text-right ${percentCompleteFailed !== undefined ? 'border-nc-danger-text' : ''}`}
        style={{ width: UNIT_W }}
        data-cell={`${i}-percentComplete`}
        tabIndex={rows.length * 3 + i + 1}
        inputMode="decimal"
        value={displayPercentValue(draft.percentComplete, percentCompleteIsFocused)}
        placeholder="% complete"
        aria-label={`${item.itemNumber} percent complete`}
        onFocus={() => setFocusedCell({ itemId: item.id, field: 'percentComplete' })}
        onBlur={() => {
          setFocusedCell(null)
          void commitEarnedField(item, 'percentComplete')
        }}
        onChange={(e) => updateDraft(item.id, 'percentComplete', e.target.value)}
        onKeyDown={(e) => handleKeyDown(e, item, 'percentComplete', i)}
      />
    )

    const authorizedValueInput = (
      <Input
        className={`nc-numeric text-right ${authorizedValueFailed !== undefined ? 'border-nc-danger-text' : ''}`}
        style={{ width: EXT_W }}
        data-cell={`${i}-authorizedValue`}
        tabIndex={rows.length * 4 + i + 1}
        inputMode="decimal"
        value={displayValue(draft.authorizedValue, authorizedValueIsFocused)}
        placeholder="Authorized value"
        aria-label={`${item.itemNumber} authorized value`}
        onFocus={() => setFocusedCell({ itemId: item.id, field: 'authorizedValue' })}
        onBlur={() => {
          setFocusedCell(null)
          void commitEarnedField(item, 'authorizedValue')
        }}
        onChange={(e) => updateDraft(item.id, 'authorizedValue', e.target.value)}
        onKeyDown={(e) => handleKeyDown(e, item, 'authorizedValue', i)}
      />
    )

    return (
      <Fragment key={item.id}>
        {/* A failed write outranks the plain "not priced yet" tint — same
            neutral fact either way underneath, but one of them is a
            problem to go fix and the other one just hasn't happened yet.
            This has to stay after focus leaves the row, not just flash at
            the moment of failure. */}
        <TR className={rowHasFailure ? 'bg-nc-danger-bg/40' : !row.priced ? 'bg-nc-secondary/60' : undefined}>
          <TD compact className="nc-numeric align-middle">
            {item.itemNumber}
          </TD>
          <TD prose compact className="align-middle">
            <div className="max-w-[190px] truncate" title={item.description}>
              {item.description}
            </div>
          </TD>
          <TD align="right" compact className="nc-numeric align-middle">
            {item.itemKind === 'unit_price' ? (
              <>
                {fmtQuantity(item.approximateQuantity)} <span className="text-nc-text-muted">{item.unit}</span>
              </>
            ) : (
              '—'
            )}
          </TD>

          {/* Unit cost — editable only for a Unit Price Item; a rate has no
              meaning for Lump Sum/Provisional Sum. */}
          <TD align="right" dense compact className="align-middle">
            {item.itemKind === 'unit_price' ? (
              <div
                className="flex items-center justify-end gap-1.5"
                onFocus={() => setFocusedCell({ itemId: item.id, field: costCommitField })}
                onBlur={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                  setFocusedCell(null)
                  void commitRate(item, costCommitField)
                }}
              >
                {canEdit ? costInput : <MoneyDisplay value={row.costPrice} width={UNIT_W} />}
                {/* Reserved width only while the basis picker is actually
                    shown (focus, or already committed as 'total') — not on
                    every row regardless, which used to hold a full 100px
                    open behind nothing for every Unit Price row that never
                    shows it. */}
                {showBasisControl && (
                  <div style={{ width: 100 }} className="shrink-0">
                    <Select
                      aria-label={`${item.itemNumber} cost basis`}
                      style={{ width: 100 }}
                      className="py-1 text-xs"
                      tabIndex={i * 2 + 2}
                      value={draft.costBasis}
                      disabled={!canEdit}
                      onChange={(e) => void changeBasis(item, e.target.value as CostBasis)}
                    >
                      <option value="per_unit">per unit</option>
                      <option value="total">total</option>
                    </Select>
                  </div>
                )}
              </div>
            ) : (
              <DashCell width={UNIT_W} title={item.itemKind === 'lump_sum' ? 'No per-unit rate — enter the total under Extended cost' : undefined} />
            )}
          </TD>

          {/* Extended cost — derived for a Unit Price Item; IS the editable
              cost estimate for a Lump Sum Item (cost_basis is always
              'total' there, so the stored figure already is this column);
              never applicable to Provisional Sum. */}
          <TD align="right" dense compact className="align-middle">
            {item.itemKind === 'lump_sum' ? (
              canEdit ? (
                costInput
              ) : (
                <MoneyDisplay value={row.financials.extCost} width={EXT_W} />
              )
            ) : item.itemKind === 'unit_price' ? (
              <MoneyDisplay value={row.financials.extCost} width={EXT_W} />
            ) : (
              <DashCell width={EXT_W} />
            )}
          </TD>

          {/* Unit price — same shape as Unit cost. */}
          <TD align="right" dense compact className="align-middle">
            {item.itemKind === 'unit_price' ? (
              canEdit ? (
                priceInput
              ) : (
                <MoneyDisplay value={row.unitPrice} width={UNIT_W + 20} />
              )
            ) : (
              <DashCell width={UNIT_W + 20} title={item.itemKind === 'lump_sum' ? 'No per-unit rate — enter the total under Extended amount' : undefined} />
            )}
          </TD>

          {/* Extended amount — derived for Unit Price; IS the editable
              lump sum price for Lump Sum; sourced from Schedule 7's own
              Provisional Sum allowance (never entered here) for
              Provisional Sum. */}
          <TD align="right" dense compact className="align-middle">
            {item.itemKind === 'lump_sum' ? (
              canEdit ? (
                priceInput
              ) : (
                <ExtAmountCell value={row.financials.extAmount} width={EXT_W} maxValue={maxExtAmount} />
              )
            ) : (
              <ExtAmountCell value={row.financials.extAmount} width={EXT_W} maxValue={maxExtAmount} />
            )}
          </TD>

          {/* Margin — MARGIN, NOT MARKUP: of revenue (Ext. amount), never
              of cost. Never computed for Provisional Sum (reimbursed, not
              margined) — em-dash, never 0. */}
          <TD align="right" compact className={`nc-numeric align-middle ${row.financials.margin !== null && row.financials.margin < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
            {row.financials.margin === null ? '—' : rate(row.financials.margin)}
          </TD>
          <TD
            align="right"
            compact
            className={`nc-numeric align-middle ${
              row.financials.marginPercent !== null && row.financials.marginPercent < 0
                ? 'font-semibold bg-nc-danger-bg text-nc-danger-text'
                : BAND_TONE[bandByRowId.get(item.id) ?? 'neutral']
            }`}
            title={
              bandByRowId.has(item.id)
                ? `${bandByRowId.get(item.id) === 'below' ? 'Bottom' : bandByRowId.get(item.id) === 'above' ? 'Top' : 'Middle'} third of this contract's own priced Items — relative, not a fixed threshold.`
                : undefined
            }
          >
            {row.financials.marginPercent === null ? '—' : percent(row.financials.marginPercent)}
          </TD>

          {/* % complete — Finance's own estimate, lump_sum Items only
              (GC 52.03(b), items_percent_only_lump_sum). Earned value for
              the Item is this / 100 x its own Ext. amount — never inferred,
              never defaulted; absent here means nothing entered, not 0%.
              Column hidden entirely unless showEarnedColumns — see its own
              declaration. */}
          {showEarnedColumns && (
            <TD align="right" dense compact className="align-middle">
              {item.itemKind === 'lump_sum' ? (
                canEdit ? percentCompleteInput : <PercentDisplay value={item.percentComplete} width={UNIT_W} />
              ) : (
                <DashCell width={UNIT_W} />
              )}
            </TD>
          )}

          {/* Authorized value — the Ministry's own advance authorization
              (GC 32.01/47.01), provisional_sum Items only. IS the Item's
              earned value directly, never prorated against anything. */}
          {showEarnedColumns && (
            <TD align="right" dense compact className="align-middle">
              {item.itemKind === 'provisional_sum' ? (
                canEdit ? authorizedValueInput : <MoneyDisplay value={item.authorizedValue} width={EXT_W} />
              ) : (
                <DashCell width={EXT_W} />
              )}
            </TD>
          )}
        </TR>
        {/* Additive to the header banner and the row's own tint, not a
            replacement — this is the detail (what actually went wrong),
            the other two are the "something's wrong, here's how many and
            where" signal for someone who's already scrolled past it. */}
        {[costFailed, unitPriceFailed, percentCompleteFailed, authorizedValueFailed].filter((msg): msg is string => msg !== undefined).map((msg, msgIndex) => (
          <TR key={msgIndex}>
            <TD colSpan={colCount} className="text-nc-danger-text">
              {msg}
            </TD>
          </TR>
        ))}
      </Fragment>
    )
  }

  function renderSubtotalRow(label: string, rowsInGroup: IndexedRow[], key: string): ReactNode {
    const agg = aggregateFinancials(rowsInGroup.map((r) => ({ itemKind: r.item.itemKind, financials: r.financials })))
    return (
      <TR key={key} className="bg-nc-secondary font-semibold">
        <TD colSpan={4} compact className="text-data align-middle text-nc-text">
          {label}
        </TD>
        <TD align="right" compact className="nc-numeric align-middle">
          {agg.extCostSum === null ? '—' : rate(agg.extCostSum)}
          {costTrackingEnabled && agg.costCoverage.total > 0 && (
            <span className="ml-1.5 whitespace-nowrap text-xs font-normal text-nc-text-muted">
              covers {agg.costCoverage.count} of {agg.costCoverage.total}
            </span>
          )}
        </TD>
        <TD compact />
        <TD align="right" compact className="nc-numeric align-middle">
          {agg.extAmountSum === null ? '—' : rate(agg.extAmountSum)}
        </TD>
        <TD align="right" compact className={`nc-numeric align-middle ${agg.marginSum !== null && agg.marginSum < 0 ? 'text-nc-danger-text' : ''}`}>
          {agg.marginSum === null ? '—' : rate(agg.marginSum)}
          {costTrackingEnabled && agg.marginCoverage.total > 0 && (
            <span className="ml-1.5 whitespace-nowrap text-xs font-normal text-nc-text-muted">
              covers {agg.marginCoverage.count} of {agg.marginCoverage.total}
            </span>
          )}
        </TD>
        <TD align="right" compact className={`nc-numeric align-middle ${agg.marginPercent !== null && agg.marginPercent < 0 ? 'text-nc-danger-text' : ''}`}>
          {agg.marginPercent === null ? '—' : percent(agg.marginPercent)}
        </TD>
        {/* % complete/Authorized value have no meaningful section subtotal
            (a summed percent is meaningless; a summed authorized value
            would just restate part of the projected-versus-actual block
            below) — left blank rather than inventing a number nobody asked
            for. Omitted along with their columns when showEarnedColumns is
            off. */}
        {showEarnedColumns && <TD compact />}
        {showEarnedColumns && <TD compact />}
      </TR>
    )
  }

  // Section headers (Schedule 7's own "SECTION N – NAME" breaks) only mean
  // anything when the visible order actually groups by section (see
  // groupBySection above).
  const groupBySectionForHeaders = groupBySection

  return (
    <div>
      <PageHeader title="Rates" subtitle={subtitle} />

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
          <NotificationBanner tone="info" className="mb-4">
            Earned, below and in the projected-versus-actual summary at the foot of the table, is Keywest's own measure — recorded quantity, or Finance's own percent-complete/authorization entry, times price. It is not the Ministry's own figure; that side is tracked separately.
          </NotificationBanner>

          {/* The cost-tracking switch itself (0042) — the one control that
              decides whether Margin/Est. cost render anywhere on this
              contract outside the entry columns just below. Unit cost/Ext.
              cost stay real and enterable regardless of this toggle; only
              what's DERIVED from them (here and everywhere else in
              NovaCore) depends on it. */}
          {canEdit && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-nc-border bg-white px-4 py-3">
              <div>
                <p className="text-sm font-medium text-nc-text">Cost tracking is {costTrackingEnabled ? 'on' : 'off'} for this contract.</p>
                <p className="text-xs text-nc-text-muted">
                  {costTrackingEnabled
                    ? 'Margin and Est. cost figures show here and elsewhere in NovaCore, computed from the costs entered below.'
                    : 'Unit cost and Ext. cost stay enterable below. Margin and Est. cost figures stay hidden everywhere in NovaCore until this is turned on.'}
                </p>
                {costTrackingError && <p className="mt-1 text-xs text-nc-danger-text">{costTrackingError}</p>}
              </div>
              <Button type="button" variant="secondary" disabled={costTrackingSaving} onClick={() => void toggleCostTracking()}>
                {costTrackingSaving ? 'Saving…' : costTrackingEnabled ? 'Turn off cost tracking' : 'Turn on cost tracking'}
              </Button>
            </div>
          )}
          {/* Separate from the explainer above — that sentence is always
              true regardless of who's looking; this one is conditional on
              the seat, and reads oddly tacked onto a sentence that isn't
              about permissions at all. No right identifiers, no role
              names — NovaCore has neither, only per-seat, per-contract
              rights. */}
          {!canEdit && (
            <NotificationBanner tone="info" className="mb-4">
              These figures are read-only for you on this contract. If you need to enter them, ask whoever manages rights on this contract.
            </NotificationBanner>
          )}
          {bandsActive && (
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
                {/* % complete and Authorized value only ever apply to Lump
                    Sum and Provisional Sum Items respectively — on a
                    contract that's mostly Unit Price Items (every real
                    contract so far), they're two more-often-than-not empty
                    columns on an already eleven-column table. Collapsed by
                    default; nothing behind this toggle is removed, only
                    hidden until asked for. */}
                <div className="mb-3">
                  <Button type="button" variant="ghost" onClick={() => setShowEarnedColumns((v) => !v)} aria-pressed={showEarnedColumns}>
                    {showEarnedColumns ? 'Hide completion & authorization columns' : 'Show completion & authorization columns'}
                  </Button>
                </div>
                <Table fullWidth={false} maxHeight="calc(100vh - 280px)" className="w-fit">
                <THead className="sticky top-0 z-10">
                  {failedItemIds.size > 0 && (
                    <tr>
                      <th colSpan={colCount} className="bg-nc-danger-bg p-0 text-left">
                        <button
                          type="button"
                          onClick={focusFirstFailedRow}
                          className="w-full px-4 py-2 text-left text-sm font-semibold text-nc-danger-text hover:bg-nc-danger-bg/70"
                        >
                          {failedItemIds.size} row{failedItemIds.size === 1 ? '' : 's'} didn't save — click to go to the first one
                        </button>
                      </th>
                    </tr>
                  )}
                  <TR>
                    {sortableHeader('itemNumber', 'Item #')}
                    <TH compact>Description</TH>
                    {sortableHeader('quantity', 'Approx. Qty', 'right')}
                    <TH align="right" compact>
                      Unit cost
                    </TH>
                    <TH align="right" compact>
                      Extended cost
                    </TH>
                    <TH align="right" compact>
                      Unit price
                    </TH>
                    {sortableHeader('extAmount', 'Extended amount', 'right')}
                    <TH align="right" compact>
                      Margin
                    </TH>
                    <TH align="right" compact>
                      Margin %
                    </TH>
                    {showEarnedColumns && (
                      <TH align="right" compact>
                        % complete
                      </TH>
                    )}
                    {showEarnedColumns && (
                      <TH align="right" compact>
                        Authorized value
                      </TH>
                    )}
                  </TR>
                </THead>
                <TBody>
                  {groupBySectionForHeaders && sectionGroups
                    ? sectionGroups.map((group) => (
                        <Fragment key={group.prefix}>
                          <TR>
                            <TD colSpan={colCount} className="text-xs font-semibold uppercase tracking-wide text-nc-text-muted border-t border-nc-border first:border-t-0">
                              {sectionLabel(group.prefix)}
                            </TD>
                          </TR>
                          {group.rows.map((row) => renderDataRow(row))}
                          {renderSubtotalRow(`${sectionLabel(group.prefix)} subtotal`, group.rows, group.prefix)}
                        </Fragment>
                      ))
                    : rows.map((row) => renderDataRow(row))}
                </TBody>
                <tfoot>
                  <tr>
                    <td colSpan={4} className="text-data border-t border-nc-border bg-nc-navy px-2 py-3 text-right font-semibold text-white">
                      Grand total
                    </td>
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-navy px-2 py-3 text-right font-semibold text-white">
                      {grandTotal.extCostSum === null ? '—' : rate(grandTotal.extCostSum)}
                      {costTrackingEnabled && grandTotal.costCoverage.total > 0 && (
                        <span className="ml-1.5 block whitespace-nowrap text-xs font-normal opacity-80">
                          covers {grandTotal.costCoverage.count} of {grandTotal.costCoverage.total} items
                        </span>
                      )}
                    </td>
                    <td className="border-t border-nc-border bg-nc-navy" />
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-navy px-2 py-3 text-right font-semibold text-white">
                      {grandTotal.extAmountSum === null ? '—' : rate(grandTotal.extAmountSum)}
                    </td>
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-navy px-2 py-3 text-right font-semibold text-white">
                      {grandTotal.marginSum === null ? '—' : rate(grandTotal.marginSum)}
                      {costTrackingEnabled && grandTotal.marginCoverage.total > 0 && (
                        <span className="ml-1.5 block whitespace-nowrap text-xs font-normal opacity-80">
                          covers {grandTotal.marginCoverage.count} of {grandTotal.marginCoverage.total} items
                        </span>
                      )}
                    </td>
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-navy px-2 py-3 text-right font-semibold text-white">
                      {grandTotal.marginPercent === null ? '—' : percent(grandTotal.marginPercent)}
                    </td>
                    {/* % complete/Authorized value: no grand-total figure of
                        their own — see renderSubtotalRow's own comment; the
                        real totals for what they feed into are the
                        projected-versus-actual block directly below.
                        Omitted along with their columns when
                        showEarnedColumns is off. */}
                    {showEarnedColumns && <td className="border-t border-nc-border bg-nc-navy" />}
                    {showEarnedColumns && <td className="border-t border-nc-border bg-nc-navy" />}
                  </tr>
                  {/* Projected versus actual — beside the tender price
                      reconciliation, never merged with it or with each
                      other: two separate figures, side by side, because
                      blending them (a quantity-weighted completion
                      percentage) has been tried and removed from this
                      product twice. Shown regardless of canEdit — this is
                      a read of what's already on file, same posture as the
                      Grand total row above it. */}
                  <tr>
                    <td colSpan={colCount} className="border-t border-nc-border bg-white px-4 py-3 text-sm">
                      <div className="grid grid-cols-2 gap-8">
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
                            <p className="mt-1 text-xs text-nc-text-muted">
                              Covers {measured.coverage.count} of {measured.coverage.total} items — the rest have no Unit price on file yet.
                            </p>
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
                            <p className="mt-1 text-xs text-nc-text-muted">
                              Covers {unmeasured.coverage.count} of {unmeasured.coverage.total} items — the rest have nothing recorded as earned yet.
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                  {/* Tender price reconciliation — verifies every transcribed
                      price at once against the one figure a person read off
                      the award document. The statement (or its absence) is
                      always shown; a canEdit seat also always gets the
                      entry field, pre-filled once a price is on file, so a
                      typo or a revised award figure can be corrected here
                      too — not just entered once and then locked. */}
                  <tr>
                    <td colSpan={colCount} className="border-t border-nc-border bg-nc-secondary px-4 py-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        {tenderPrice !== null && reconciliation ? (
                          reconciliation.matches ? (
                            <span className="text-nc-success-text">
                              Ext. amount totals {grandTotal.extAmountSum === null ? '—' : rate(grandTotal.extAmountSum)} — matches the tendered price of {rate(tenderPrice)}.
                            </span>
                          ) : (
                            // Plain, not alarmed — a difference here can
                            // legitimately mean prices are still being
                            // entered, not that something is wrong.
                            <span className="text-nc-text">
                              Ext. amount totals {grandTotal.extAmountSum === null ? '—' : rate(grandTotal.extAmountSum)},{' '}
                              {rate(Math.abs(reconciliation.differenceCents) / 100)} {reconciliation.differenceCents > 0 ? 'over' : 'under'} the tendered price of{' '}
                              {rate(tenderPrice)}.
                            </span>
                          )
                        ) : (
                          <span className="text-nc-text-muted">No tender price on file to verify against.</span>
                        )}
                        {canEdit && (
                          <>
                            <Input
                              className="nc-numeric text-right"
                              style={{ width: 160 }}
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
                            {tenderPriceError && <span className="text-nc-danger-text">{tenderPriceError}</span>}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                </tfoot>
              </Table>
              </>
            ))}
        </>
      )}
    </div>
  )
}
