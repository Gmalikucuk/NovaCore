import { Fragment, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconArrowDown, IconArrowUp, IconArrowsSort, IconCurrencyDollar } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, upsertItemPrice, type ItemPrice } from '../../lib/supabase/prices'
import { margin, sumOrNull, type CostBasis } from '../../lib/calculations/margin'
import { compareItemCodes } from '../../lib/calculations/naturalSort'
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
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null)

  // Contract quantity descending by default — the largest few items carry
  // most of a paving contract's value, so a PM entering rates hits them
  // first and can stop there if she wants. Sortable so the item-number
  // order (scrambled by the default) is reachable too.
  const [sortKey, setSortKey] = useState<SortKey>('quantity')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

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
      if (rowError?.id === item.id) setRowError(null)
    } catch (err) {
      setRowError({ id: item.id, message: errorMessage(err) })
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
      if (rowError?.id === item.id) setRowError(null)
    } catch (err) {
      setRowError({ id: item.id, message: errorMessage(err) })
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>, item: Item, field: 'cost' | 'unitPrice', rowIndex: number) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    void commitRate(item, field).then(() => {
      if (rowIndex + 1 < rows.length) focusCell(rowIndex + 1, field)
    })
  }

  const subtitle = `${contract.name}${status === 'ready' ? ` · ${costedCount} of ${rows.length} costed` : ''}`

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
                <Table>
                  <THead>
                    <TR>
                      {sortableHeader('itemNumber', 'Item #')}
                      <TH>Description</TH>
                      {sortableHeader('quantity', 'Approximate Quantity', 'right')}
                      {/* Explicit width on the header cell, not the input below — a table's
                          auto-layout algorithm fixes a column's width from ANY cell in it that
                          states one, and a plain CSS length here is unambiguous regardless of
                          the data type scale's font size (unlike the HTML `size` attribute this
                          replaced, which is measured in characters against the rendered font —
                          coupling the fix to a token this same pass already changed once). */}
                      <TH align="right" style={{ width: 150 }}>
                        Est. cost
                      </TH>
                      <TH align="right" style={{ width: 130 }}>
                        Unit Price
                      </TH>
                      <TH align="right">Est. contract margin</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((row, i) => {
                      const draft = drafts.get(row.item.id) ?? toDraft(row.item, undefined)
                      return (
                        <Fragment key={row.item.id}>
                          <TR className={!row.priced ? 'bg-nc-secondary/60' : undefined}>
                            <TD className="nc-numeric">{row.item.itemNumber}</TD>
                            <TD prose>{row.item.description}</TD>
                            <TD align="right" className="nc-numeric">
                              {row.unitPriced ? (
                                <>
                                  {fmtQuantity(row.item.approximateQuantity)} <span className="text-nc-text-muted">{row.item.unit}</span>
                                </>
                              ) : (
                                '—'
                              )}
                            </TD>
                            <TD align="right" dense>
                              <div className="flex flex-col items-end gap-1">
                                <Input
                                  className="nc-numeric text-right"
                                  data-cell={`${i}-cost`}
                                  inputMode="decimal"
                                  placeholder="—"
                                  value={draft.cost}
                                  readOnly={!canEdit}
                                  onChange={(e) => updateDraft(row.item.id, 'cost', e.target.value)}
                                  onBlur={() => void commitRate(row.item, 'cost')}
                                  onKeyDown={(e) => handleKeyDown(e, row.item, 'cost', i)}
                                />
                                {row.unitPriced ? (
                                  <Select
                                    aria-label={`${row.item.itemNumber} cost basis`}
                                    className="w-auto py-1 text-xs"
                                    value={draft.costBasis}
                                    disabled={!canEdit}
                                    onChange={(e) => void changeBasis(row.item, e.target.value as CostBasis)}
                                  >
                                    <option value="per_unit">per unit</option>
                                    <option value="total">total</option>
                                  </Select>
                                ) : (
                                  <span className="text-xs text-nc-text-muted">total</span>
                                )}
                                {row.derivedPerUnit !== null && (
                                  <span className="nc-numeric whitespace-nowrap text-xs text-nc-text-muted">≈ {money(row.derivedPerUnit)}/unit, against Approx. Qty</span>
                                )}
                              </div>
                            </TD>
                            <TD align="right" dense={row.unitPriced}>
                              {row.unitPriced ? (
                                <Input
                                  className="nc-numeric text-right"
                                  data-cell={`${i}-unitPrice`}
                                  inputMode="decimal"
                                  placeholder="—"
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
                            <TD align="right" className={`nc-numeric ${row.contractMargin !== null && row.contractMargin < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
                              {row.contractMargin === null ? '—' : money(row.contractMargin)}
                            </TD>
                          </TR>
                          {rowError?.id === row.item.id && (
                            <TR>
                              <TD colSpan={6} className="text-nc-danger-text">
                                {rowError.message}
                              </TD>
                            </TR>
                          )}
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
