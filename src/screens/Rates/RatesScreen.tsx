import { Fragment, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconArrowDown, IconArrowUp, IconArrowsSort, IconCurrencyDollar } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, upsertItemPrice, type ItemPrice } from '../../lib/supabase/prices'
import { margin, sumOrNull, type CostBasis } from '../../lib/calculations/margin'
import { compareItemCodes, sectionLabel, sectionPrefix } from '../../lib/calculations/naturalSort'
import { errorMessage } from '../../lib/errorMessage'
import { money, quantity as fmtQuantity } from '../../lib/format'
import { EmptyState, Input, NotificationBanner, PageHeader, SandboxBanner, Select, Spinner, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

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

function focusCell(row: number, field: 'cost' | 'unitPrice') {
  const el = document.querySelector<HTMLInputElement>(`[data-cell="${row}-${field}"]`)
  el?.focus()
  el?.select()
}

type SortKey = 'itemNumber' | 'quantity'

function SortIndicator({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <IconArrowsSort size={13} stroke={1.75} className="inline-block opacity-40" />
  return dir === 'asc' ? <IconArrowUp size={13} stroke={2} className="inline-block" /> : <IconArrowDown size={13} stroke={2} className="inline-block" />
}

export function RatesScreen() {
  const contract = useOutletContext<MyContract>()
  // view_rates alone reaches this screen — a finance-only seat (view_rates
  // without set_cost/set_unit_price) needs exactly that: see the rates,
  // change nothing. The screen isn't hidden for that seat; the inputs are
  // read-only instead (see canEdit below). Per 0008's UI-gating rule: UI
  // gates are a courtesy, not enforcement — the RLS policies (item_prices_
  // insert_right / item_prices_update_right — set_unit_price required only
  // when the Item is actually unit_price, 0023) are what actually block the
  // write either way.
  const canEdit = contract.setCost && contract.setUnitPrice

  const [items, setItems] = useState<Item[]>([])
  const [prices, setPrices] = useState<Map<string, ItemPrice>>(new Map())
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map())
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  // Every cell whose last write attempt failed, keyed `${itemId}:${field}` —
  // not just the most recent one. Enter never waits for a commit to resolve
  // before moving on (a 48-row pass has to stay fast), which means a failure
  // can land several rows behind wherever the person's focus already is by
  // the time it's known. This has to survive past that moment, not just
  // flash where the failure happened — cleared only when a later write for
  // that exact cell succeeds, never on a timer, never by scrolling past it.
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

  // The cost-basis picker is per_unit on almost every Unit Price Item —
  // showing it stacked under Est. cost on all 48 rows for a choice that's
  // rarely touched is what pushed every row past single-line height. It's
  // shown only when there's a reason to look at it: the Item is already
  // priced as a total (so its basis differs from the silent per_unit
  // default and needs to stay visible), or the cost cell is focused right
  // now (so it's reachable the moment someone actually wants to change it).
  const [focusedCostId, setFocusedCostId] = useState<string | null>(null)

  // Item # ascending — Schedule 7 order, the order of the tender document
  // being transcribed from. Sorting by Approximate Quantity mixes units of
  // measure (354,250 Square Metre above 45,900 Tonne conveys nothing) and
  // buried the contract's largest-value Item in fourth position; kept as an
  // available sort (meaningful within one UOM) but no longer the default.
  // Once Unit Prices exist, sorting by Extended Amount would be the
  // meaningful importance ranking — not built now.
  const [sortKey, setSortKey] = useState<SortKey>('itemNumber')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

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
      setSortDir(key === 'quantity' ? 'desc' : 'asc')
    }
  }

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...items].sort((a, b) => (sortKey === 'itemNumber' ? compareItemCodes(a.itemNumber, b.itemNumber) * dir : (a.approximateQuantity - b.approximateQuantity) * dir))
  }, [items, sortKey, sortDir])

  const rows = useMemo(
    () =>
      sorted.map((item) => {
        // Unit Price and Contract margin are per-unit-only concepts —
        // meaningless for a Lump Sum (always qty 1) or Provisional Sum
        // (paid on value authorized, not a rate) — so those two kinds
        // never get a Unit Price cell or a margin figure regardless of what
        // item_prices holds. Cost is different since 0023: every kind is
        // costable now, Lump Sum/Provisional Sum on a total basis only.
        const unitPriced = item.itemKind === 'unit_price'
        const price = prices.get(item.id)
        const cost = price?.costPrice ?? null
        const costBasis = price?.costBasis ?? null
        const unitPrice = unitPriced ? (price?.unitPrice ?? null) : null
        // A total entered on a Unit Price Item is a real number about the
        // whole Item, not a rate — this is the OTHER reading, derived for
        // display only (never stored, never fed back into margin math),
        // and only exists to answer "roughly what would that be per unit
        // against the Approximate Quantity" for a human comparing it with
        // a per-unit-priced Item next to it.
        const derivedPerUnit = unitPriced && costBasis === 'total' && cost !== null && item.approximateQuantity > 0 ? cost / item.approximateQuantity : null
        return {
          item,
          unitPriced,
          cost,
          costBasis,
          unitPrice,
          derivedPerUnit,
          // A Unit Price Item is "priced" once both a cost and a Unit
          // Price are known (margin needs both). A Lump Sum/Provisional
          // Sum Item is "priced" the moment its cost is — it has no Unit
          // Price to wait for.
          priced: unitPriced ? cost !== null && unitPrice !== null : cost !== null,
          contractMargin: unitPriced ? margin(item.approximateQuantity, cost, unitPrice, costBasis) : null,
        }
      }),
    [sorted, prices],
  )

  const unitPriceRows = useMemo(() => rows.filter((r) => r.unitPriced), [rows])
  const unitPricedFullyPriced = unitPriceRows.filter((r) => r.priced).length
  const costedCount = rows.filter((r) => r.cost !== null).length
  const totalMargin = sumOrNull(rows.map((r) => r.contractMargin))

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
    for (let i = 0; i < rows.length; i++) {
      const id = rows[i].item.id
      if (failedCells.has(`${id}:cost`)) return focusCell(i, 'cost')
      if (failedCells.has(`${id}:unitPrice`)) return focusCell(i, 'unitPrice')
    }
  }

  const subtitle = `${contract.name}${status === 'ready' ? ` · ${costedCount} of ${rows.length} have an Est. cost` : ''}`

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

  // Section headers (Schedule 7's own "SECTION N – NAME" breaks) only mean
  // anything when the visible order actually groups by section — true
  // under the Item # sort (a section's items share its leading prefix, so
  // they're already contiguous), not under the Quantity sort, where the
  // same header would have to reappear every time the interleaving crossed
  // back into a section already shown once. `i` here is the row's index
  // into the single flat `rows` array regardless of a header being
  // rendered above it — tab order and Enter's "next row" both key off this
  // same index, so inserting a header never shifts it.
  let lastSectionPrefix = ''
  const groupBySection = sortKey === 'itemNumber'

  return (
    <div>
      <PageHeader title="Rates" subtitle={subtitle} />

      <SandboxBanner contract={contract} />

      {!contract.viewRates ? (
        <EmptyState title="You don't have permission to view rates on this contract." />
      ) : (
        <>
          {/* One banner, not a stack: the bid-estimate disclosure is always
              relevant here, so the read-only state (when it applies) is a
              second sentence in the SAME box rather than a second box —
              the "unpriced" caveat below moves to the table's own footer,
              next to the total it actually qualifies, rather than sitting
              up here as a third. */}
          <NotificationBanner tone="info" className="mb-4">
            Cost and margin below are Keywest's own bid estimate, entered on this screen — actual cost isn't recorded in NovaCore yet.
            {!canEdit && " These are read-only for you — ask a project manager to grant rate-setting permission if you need to enter figures."}
          </NotificationBanner>

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
                {/* fullWidth=false + w-fit mx-auto: this table's columns are
                    mostly narrow and none of them wants the leftover width,
                    so letting it stretch to the page's full 1800px cap put
                    ~600px of dead gutter between Description and
                    Approximate Quantity. Sized to its own content and
                    centered instead — see the Table component's own
                    comment for why fullWidth needed a prop rather than an
                    override at this call site (the shared FIELD_BASE/table
                    classes are in the same stylesheet layer as anything
                    passed via className, so which one wins is a stylesheet-
                    order question, not a JSX-order one).

                    maxHeight makes this table's own wrapper the scrolling
                    region (see Table's comment for why that's load-bearing
                    for the sticky header below, not cosmetic) — a 44-48px
                    row height times up to 48 rows means the column
                    headings would otherwise scroll out of view almost
                    immediately, in the middle of a single transcription
                    pass. The subtracted allowance is this page's own
                    header + banner + padding above the table. */}
                <Table fullWidth={false} maxHeight="calc(100vh - 280px)" className="mx-auto w-fit">
                  <THead className="sticky top-0 z-10">
                    {/* Part of the sticky header, not a page-level banner —
                        it has to survive the exact same scrolling that
                        buries the row it's about, and it has no dismiss
                        control at all: it goes away when the count reaches
                        zero, on its own, never before. */}
                    {failedItemIds.size > 0 && (
                      <tr>
                        <th colSpan={6} className="bg-nc-danger-bg p-0 text-left">
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
                      {sortableHeader('quantity', 'Approximate Quantity', 'right')}
                      <TH align="right">Est. cost</TH>
                      <TH align="right">Unit Price</TH>
                      <TH align="right">Est. contract margin</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((row, i) => {
                      const draft = drafts.get(row.item.id) ?? toDraft(row.item, undefined)
                      const prefix = groupBySection ? sectionPrefix(row.item.itemNumber) : null
                      const showSectionHeader = prefix !== null && prefix !== lastSectionPrefix
                      if (showSectionHeader) lastSectionPrefix = prefix

                      // Shown when there's a reason to look at it: focused
                      // right now, or already committed as a total (see the
                      // state comment above) — never for the silent
                      // per_unit default sitting untouched.
                      const showBasisControl = row.unitPriced && (focusedCostId === row.item.id || draft.costBasis === 'total')

                      const costFailed = failedCells.get(`${row.item.id}:cost`)
                      const unitPriceFailed = failedCells.get(`${row.item.id}:unitPrice`)
                      const rowHasFailure = costFailed !== undefined || unitPriceFailed !== undefined

                      return (
                        <Fragment key={row.item.id}>
                          {showSectionHeader && (
                            <TR>
                              <TD colSpan={6} className={`text-xs font-semibold uppercase tracking-wide text-nc-text-muted ${i === 0 ? '' : 'border-t border-nc-border'}`}>
                                {sectionLabel(prefix)}
                              </TD>
                            </TR>
                          )}
                          {/* A failed write outranks the plain "not priced
                              yet" tint — same neutral fact either way
                              underneath, but one of them is a problem to go
                              fix and the other one just hasn't happened
                              yet. This has to stay after focus leaves the
                              row, not just flash at the moment of failure —
                              it's the only thing left proving the row is
                              still wrong once the pass has moved on. */}
                          <TR className={rowHasFailure ? 'bg-nc-danger-bg/40' : !row.priced ? 'bg-nc-secondary/60' : undefined}>
                            <TD className="nc-numeric align-middle">{row.item.itemNumber}</TD>
                            <TD prose className="align-middle">
                              <div className="max-w-[300px] truncate" title={row.item.description}>
                                {row.item.description}
                              </div>
                            </TD>
                            <TD align="right" className="nc-numeric align-middle">
                              {row.unitPriced ? (
                                <>
                                  {fmtQuantity(row.item.approximateQuantity)} <span className="text-nc-text-muted">{row.item.unit}</span>
                                </>
                              ) : (
                                '—'
                              )}
                            </TD>
                            <TD align="right" dense className="align-middle">
                              <div className="flex items-center justify-end gap-1.5">
                                <Input
                                  className={`nc-numeric text-right ${costFailed !== undefined ? 'border-nc-danger-text' : ''}`}
                                  style={{ width: 110 }}
                                  data-cell={`${i}-cost`}
                                  tabIndex={i + 1}
                                  inputMode="decimal"
                                  value={draft.cost}
                                  readOnly={!canEdit}
                                  onChange={(e) => updateDraft(row.item.id, 'cost', e.target.value)}
                                  onFocus={() => setFocusedCostId(row.item.id)}
                                  onBlur={() => {
                                    setFocusedCostId(null)
                                    void commitRate(row.item, 'cost')
                                  }}
                                  onKeyDown={(e) => handleKeyDown(e, row.item, 'cost', i)}
                                />
                                {row.unitPriced ? (
                                  showBasisControl && (
                                    <Select
                                      aria-label={`${row.item.itemNumber} cost basis`}
                                      style={{ width: 80 }}
                                      className="py-1 text-xs"
                                      tabIndex={-1}
                                      value={draft.costBasis}
                                      disabled={!canEdit}
                                      onFocus={() => setFocusedCostId(row.item.id)}
                                      onBlur={() => setFocusedCostId(null)}
                                      onChange={(e) => void changeBasis(row.item, e.target.value as CostBasis)}
                                    >
                                      <option value="per_unit">/unit</option>
                                      <option value="total">total</option>
                                    </Select>
                                  )
                                ) : (
                                  <span className="text-xs text-nc-text-muted">total</span>
                                )}
                                {row.derivedPerUnit !== null && (
                                  <span className="nc-numeric whitespace-nowrap text-xs text-nc-text-muted">≈ {money(row.derivedPerUnit)}/unit</span>
                                )}
                              </div>
                            </TD>
                            <TD align="right" dense={row.unitPriced} className="align-middle">
                              {row.unitPriced ? (
                                <Input
                                  className={`nc-numeric text-right ${unitPriceFailed !== undefined ? 'border-nc-danger-text' : ''}`}
                                  style={{ width: 130 }}
                                  data-cell={`${i}-unitPrice`}
                                  tabIndex={rows.length + i + 1}
                                  inputMode="decimal"
                                  value={draft.unitPrice}
                                  readOnly={!canEdit}
                                  onChange={(e) => updateDraft(row.item.id, 'unitPrice', e.target.value)}
                                  onBlur={() => void commitRate(row.item, 'unitPrice')}
                                  onKeyDown={(e) => handleKeyDown(e, row.item, 'unitPrice', i)}
                                />
                              ) : (
                                <span className="text-nc-text-muted">—</span>
                              )}
                            </TD>
                            <TD align="right" className={`nc-numeric align-middle ${row.contractMargin !== null && row.contractMargin < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
                              {row.contractMargin === null ? '—' : money(row.contractMargin)}
                            </TD>
                          </TR>
                          {/* Additive to the header banner and the row's
                              own tint, not a replacement — this is the
                              detail (what actually went wrong), the other
                              two are the "something's wrong, here's how
                              many and where" signal for someone who's
                              already scrolled past it. Cost and Unit Price
                              can each be mid-failure independently. */}
                          {[costFailed, unitPriceFailed].filter((msg): msg is string => msg !== undefined).map((msg, msgIndex) => (
                            <TR key={msgIndex}>
                              <TD colSpan={6} className="text-nc-danger-text">
                                {msg}
                              </TD>
                            </TR>
                          ))}
                        </Fragment>
                      )
                    })}
                  </TBody>
                  <tfoot>
                    <tr>
                      <td colSpan={5} className="text-data border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold text-nc-text">
                        Est. contract margin — {unitPricedFullyPriced} of {unitPriceRows.length} unit-price items priced
                        {/* The caveat that used to be its own banner at the top of the
                            page, moved to sit next to the number it actually qualifies. */}
                        {unitPricedFullyPriced < unitPriceRows.length && <span className="font-normal text-nc-text-muted"> (unpriced items excluded from the total)</span>}
                      </td>
                      <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold text-nc-text">{money(totalMargin)}</td>
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
