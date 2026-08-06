import { Fragment, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconArrowDown, IconArrowUp, IconArrowsSort, IconCurrencyDollar } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { updateTenderPrice } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, upsertItemPrice, type ItemPrice } from '../../lib/supabase/prices'
import type { CostBasis } from '../../lib/calculations/margin'
import { aggregateFinancials, reconcileTenderPrice, rowFinancials, type RowFinancials } from '../../lib/calculations/bidSummary'
import { compareItemCodes, sectionLabel, sectionPrefix } from '../../lib/calculations/naturalSort'
import { errorMessage } from '../../lib/errorMessage'
import { percent, quantity as fmtQuantity, rate } from '../../lib/format'
import { EmptyState, Input, NotificationBanner, PageHeader, SandboxBanner, Select, Spinner, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

const COL_COUNT = 9

interface Draft {
  cost: string
  costBasis: CostBasis
  unitPrice: string
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

function focusCell(row: number, field: 'cost' | 'unitPrice') {
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

  const [items, setItems] = useState<Item[]>([])
  const [prices, setPrices] = useState<Map<string, ItemPrice>>(new Map())
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

  function markFailed(itemId: string, field: 'cost' | 'unitPrice', message: string) {
    setFailedCells((prev) => new Map(prev).set(`${itemId}:${field}`, message))
  }
  function clearFailed(itemId: string, field: 'cost' | 'unitPrice') {
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
  const [focusedCell, setFocusedCell] = useState<{ itemId: string; field: 'cost' | 'unitPrice' } | null>(null)

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

  useEffect(() => {
    setStatus('loading')
    Promise.all([fetchItems(contract.id), fetchItemPrices(contract.id)])
      .then(([itemRows, priceRows]) => {
        setItems(itemRows)
        const priceMap = new Map(priceRows.map((p) => [p.itemId, p]))
        setPrices(priceMap)
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
        const financials = rowFinancials({
          itemKind: item.itemKind,
          approximateQuantity: item.approximateQuantity,
          provisionalSum: item.provisionalSum,
          costPrice,
          costBasis,
          unitPrice,
        })
        // A Provisional Sum Item is "priced" the moment Schedule 7's own
        // allowance is on the Item — nothing is ever entered for it here.
        // Every other kind is priced once both its extended figures are
        // known (margin needs both).
        const priced = item.itemKind === 'provisional_sum' ? item.provisionalSum !== null : financials.extCost !== null && financials.extAmount !== null
        return { item, costPrice, costBasis, unitPrice, financials, priced }
      }),
    [items, prices],
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

  function updateDraft(id: string, field: 'cost' | 'unitPrice', value: string) {
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
    setDrafts((prev) => new Map(prev).set(item.id, { cost: '', costBasis: newBasis, unitPrice: prev.get(item.id)?.unitPrice ?? '' }))
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
  function focusFirstFailedRow() {
    for (const row of rows) {
      if (failedCells.has(`${row.item.id}:cost`)) return focusCell(row.rowIndex, 'cost')
      if (failedCells.has(`${row.item.id}:unitPrice`)) return focusCell(row.rowIndex, 'unitPrice')
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
  const subtitle = `${contract.name}${status === 'ready' ? ` · ${rows.length} Items · ${grandTotal.costCoverage.count} of ${grandTotal.costCoverage.total} have an Est. cost` : ''}`

  function sortableHeader(key: SortKey, label: string, align: 'left' | 'right' = 'left'): ReactNode {
    return (
      <TH align={align} onClick={() => toggleSort(key)} className="cursor-pointer select-none hover:bg-nc-border/40">
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
    const rowHasFailure = costFailed !== undefined || unitPriceFailed !== undefined

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

    return (
      <Fragment key={item.id}>
        {/* A failed write outranks the plain "not priced yet" tint — same
            neutral fact either way underneath, but one of them is a
            problem to go fix and the other one just hasn't happened yet.
            This has to stay after focus leaves the row, not just flash at
            the moment of failure. */}
        <TR className={rowHasFailure ? 'bg-nc-danger-bg/40' : !row.priced ? 'bg-nc-secondary/60' : undefined}>
          <TD className="nc-numeric align-middle">{item.itemNumber}</TD>
          <TD prose className="align-middle">
            <div className="max-w-[240px] truncate" title={item.description}>
              {item.description}
            </div>
          </TD>
          <TD align="right" className="nc-numeric align-middle">
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
          <TD align="right" dense className="align-middle">
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
                <div style={{ width: 100 }} className="shrink-0">
                  {showBasisControl && (
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
                  )}
                </div>
              </div>
            ) : (
              <DashCell width={UNIT_W} title={item.itemKind === 'lump_sum' ? 'No per-unit rate — enter the total under Ext. cost' : undefined} />
            )}
          </TD>

          {/* Ext. cost — derived for a Unit Price Item; IS the editable
              cost estimate for a Lump Sum Item (cost_basis is always
              'total' there, so the stored figure already is this column);
              never applicable to Provisional Sum. */}
          <TD align="right" dense className="align-middle">
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
          <TD align="right" dense className="align-middle">
            {item.itemKind === 'unit_price' ? (
              canEdit ? (
                priceInput
              ) : (
                <MoneyDisplay value={row.unitPrice} width={UNIT_W + 20} />
              )
            ) : (
              <DashCell width={UNIT_W + 20} title={item.itemKind === 'lump_sum' ? 'No per-unit rate — enter the total under Ext. amount' : undefined} />
            )}
          </TD>

          {/* Ext. amount — derived for Unit Price; IS the editable lump
              sum price for Lump Sum; sourced from Schedule 7's own
              Provisional Sum allowance (never entered here) for
              Provisional Sum. */}
          <TD align="right" dense className="align-middle">
            {item.itemKind === 'lump_sum' ? (
              canEdit ? (
                priceInput
              ) : (
                <MoneyDisplay value={row.financials.extAmount} width={EXT_W} />
              )
            ) : (
              <MoneyDisplay value={row.financials.extAmount} width={EXT_W} />
            )}
          </TD>

          {/* Margin — MARGIN, NOT MARKUP: of revenue (Ext. amount), never
              of cost. Never computed for Provisional Sum (reimbursed, not
              margined) — em-dash, never 0. */}
          <TD align="right" className={`nc-numeric align-middle ${row.financials.margin !== null && row.financials.margin < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
            {row.financials.margin === null ? '—' : rate(row.financials.margin)}
          </TD>
          <TD align="right" className={`nc-numeric align-middle ${row.financials.marginPercent !== null && row.financials.marginPercent < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
            {row.financials.marginPercent === null ? '—' : percent(row.financials.marginPercent)}
          </TD>
        </TR>
        {/* Additive to the header banner and the row's own tint, not a
            replacement — this is the detail (what actually went wrong),
            the other two are the "something's wrong, here's how many and
            where" signal for someone who's already scrolled past it. */}
        {[costFailed, unitPriceFailed].filter((msg): msg is string => msg !== undefined).map((msg, msgIndex) => (
          <TR key={msgIndex}>
            <TD colSpan={COL_COUNT} className="text-nc-danger-text">
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
        <TD colSpan={4} className="text-data align-middle text-nc-text">
          {label}
        </TD>
        <TD align="right" className="nc-numeric align-middle">
          {agg.extCostSum === null ? '—' : rate(agg.extCostSum)}
          {agg.costCoverage.total > 0 && (
            <span className="ml-1.5 whitespace-nowrap text-xs font-normal text-nc-text-muted">
              covers {agg.costCoverage.count} of {agg.costCoverage.total}
            </span>
          )}
        </TD>
        <TD />
        <TD align="right" className="nc-numeric align-middle">
          {agg.extAmountSum === null ? '—' : rate(agg.extAmountSum)}
        </TD>
        <TD align="right" className={`nc-numeric align-middle ${agg.marginSum !== null && agg.marginSum < 0 ? 'text-nc-danger-text' : ''}`}>
          {agg.marginSum === null ? '—' : rate(agg.marginSum)}
          {agg.marginCoverage.total > 0 && (
            <span className="ml-1.5 whitespace-nowrap text-xs font-normal text-nc-text-muted">
              covers {agg.marginCoverage.count} of {agg.marginCoverage.total}
            </span>
          )}
        </TD>
        <TD align="right" className={`nc-numeric align-middle ${agg.marginPercent !== null && agg.marginPercent < 0 ? 'text-nc-danger-text' : ''}`}>
          {agg.marginPercent === null ? '—' : percent(agg.marginPercent)}
        </TD>
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
          <NotificationBanner tone="info" className="mb-4">
            Cost and margin below are Keywest's own bid estimate, entered on this screen — actual cost isn't recorded in NovaCore yet.
          </NotificationBanner>
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
              <Table fullWidth={false} maxHeight="calc(100vh - 280px)" className="w-fit">
                <THead className="sticky top-0 z-10">
                  {failedItemIds.size > 0 && (
                    <tr>
                      <th colSpan={COL_COUNT} className="bg-nc-danger-bg p-0 text-left">
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
                    <TH>Description</TH>
                    {sortableHeader('quantity', 'Approx. Qty', 'right')}
                    <TH align="right">Unit cost</TH>
                    <TH align="right">Ext. cost</TH>
                    <TH align="right">Unit price</TH>
                    {sortableHeader('extAmount', 'Ext. amount', 'right')}
                    <TH align="right">Margin</TH>
                    <TH align="right">Margin %</TH>
                  </TR>
                </THead>
                <TBody>
                  {groupBySectionForHeaders && sectionGroups
                    ? sectionGroups.map((group) => (
                        <Fragment key={group.prefix}>
                          <TR>
                            <TD colSpan={COL_COUNT} className="text-xs font-semibold uppercase tracking-wide text-nc-text-muted border-t border-nc-border first:border-t-0">
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
                    <td colSpan={4} className="text-data border-t border-nc-border bg-nc-navy px-4 py-3 text-right font-semibold text-white">
                      Grand total
                    </td>
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-navy px-4 py-3 text-right font-semibold text-white">
                      {grandTotal.extCostSum === null ? '—' : rate(grandTotal.extCostSum)}
                      {grandTotal.costCoverage.total > 0 && (
                        <span className="ml-1.5 block whitespace-nowrap text-xs font-normal opacity-80">
                          covers {grandTotal.costCoverage.count} of {grandTotal.costCoverage.total} items
                        </span>
                      )}
                    </td>
                    <td className="border-t border-nc-border bg-nc-navy" />
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-navy px-4 py-3 text-right font-semibold text-white">
                      {grandTotal.extAmountSum === null ? '—' : rate(grandTotal.extAmountSum)}
                    </td>
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-navy px-4 py-3 text-right font-semibold text-white">
                      {grandTotal.marginSum === null ? '—' : rate(grandTotal.marginSum)}
                      {grandTotal.marginCoverage.total > 0 && (
                        <span className="ml-1.5 block whitespace-nowrap text-xs font-normal opacity-80">
                          covers {grandTotal.marginCoverage.count} of {grandTotal.marginCoverage.total} items
                        </span>
                      )}
                    </td>
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-navy px-4 py-3 text-right font-semibold text-white">
                      {grandTotal.marginPercent === null ? '—' : percent(grandTotal.marginPercent)}
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
                    <td colSpan={COL_COUNT} className="border-t border-nc-border bg-nc-secondary px-4 py-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        {tenderPrice !== null && reconciliation ? (
                          reconciliation.matches ? (
                            <span className="text-nc-success-text">
                              Ext. amount totals {grandTotal.extAmountSum === null ? '—' : rate(grandTotal.extAmountSum)} — matches the tendered price of {rate(tenderPrice)}.
                            </span>
                          ) : (
                            <span className="text-nc-danger-text">
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
            ))}
        </>
      )}
    </div>
  )
}
