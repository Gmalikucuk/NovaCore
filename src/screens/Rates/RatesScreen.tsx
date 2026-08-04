import { Fragment, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconArrowDown, IconArrowUp, IconArrowsSort, IconCurrencyDollar } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, upsertItemPrice, type ItemPrice } from '../../lib/supabase/prices'
import { margin, sumOrNull } from '../../lib/calculations/margin'
import { compareItemCodes } from '../../lib/calculations/naturalSort'
import { errorMessage } from '../../lib/errorMessage'
import { money, quantity as fmtQuantity } from '../../lib/format'
import { EmptyState, Input, NotificationBanner, PageHeader, Spinner, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

interface Draft {
  cost: string
  unitPrice: string
}

function toDraft(price: ItemPrice | undefined): Draft {
  return { cost: price?.costPrice?.toString() ?? '', unitPrice: price?.unitPrice?.toString() ?? '' }
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
  // insert_right / item_prices_update_right, both requiring set_cost AND
  // set_unit_price) are what actually block the write either way.
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
        setDrafts(new Map(itemRows.map((item) => [item.id, toDraft(priceMap.get(item.id))])))
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
        // Cost/unit, Unit Price and Contract margin are all per-unit
        // figures — meaningless for a Lump Sum (always qty 1) or
        // Provisional Sum (paid on value authorized, not a rate), so those
        // kinds never read as priced here regardless of what item_prices
        // holds, and the priced/unpriced tallies below only count
        // unit_price items — this screen isn't where a lump amount is set.
        const unitPriced = item.itemKind === 'unit_price'
        const price = prices.get(item.id)
        const cost = unitPriced ? (price?.costPrice ?? null) : null
        const unitPrice = unitPriced ? (price?.unitPrice ?? null) : null
        return {
          item,
          unitPriced,
          cost,
          unitPrice,
          priced: cost !== null && unitPrice !== null,
          contractMargin: unitPriced ? margin(item.approximateQuantity, cost, unitPrice) : null,
        }
      }),
    [sorted, prices],
  )

  const unitPriceRows = useMemo(() => rows.filter((r) => r.unitPriced), [rows])
  const pricedCount = unitPriceRows.filter((r) => r.priced).length
  const totalMargin = sumOrNull(rows.map((r) => r.contractMargin))

  function updateDraft(id: string, field: 'cost' | 'unitPrice', value: string) {
    setDrafts((prev) => {
      const next = new Map(prev)
      const current = next.get(id) ?? { cost: '', unitPrice: '' }
      next.set(id, { ...current, [field]: value })
      return next
    })
  }

  async function commitRate(item: Item, field: 'cost' | 'unitPrice') {
    const draft = drafts.get(item.id) ?? { cost: '', unitPrice: '' }
    const existing = prices.get(item.id)
    const newCost = field === 'cost' ? parseRate(draft.cost) : (existing?.costPrice ?? null)
    const newUnitPrice = field === 'unitPrice' ? parseRate(draft.unitPrice) : (existing?.unitPrice ?? null)
    if (newCost === existing?.costPrice && newUnitPrice === existing?.unitPrice) return

    try {
      const saved = await upsertItemPrice({
        itemId: item.id,
        contractId: contract.id,
        costPrice: newCost,
        unitPrice: newUnitPrice,
      })
      setPrices((prev) => new Map(prev).set(item.id, saved))
      setDrafts((prev) => new Map(prev).set(item.id, toDraft(saved)))
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

  const subtitle = `${contract.name}${status === 'ready' ? ` · ${pricedCount} of ${unitPriceRows.length} priced` : ''}`

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

      {contract.isSandbox && (
        <NotificationBanner tone="danger" className="mb-4 font-medium">
          This is a sandbox contract for exercising every screen state — {contract.name} is not a real contract, and its Unit Prices are invented, not tendered figures.
        </NotificationBanner>
      )}

      {!contract.viewRates ? (
        <EmptyState title="Viewing rates needs the view_rates right on this contract." />
      ) : (
        <>
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
                {!canEdit && (
                  <NotificationBanner tone="info" className="mb-4">
                    Read-only — setting rates needs set_cost and set_unit_price on this contract.
                  </NotificationBanner>
                )}
                {pricedCount < unitPriceRows.length && (
                  <NotificationBanner tone="warning" className="mb-4">
                    {unitPriceRows.length - pricedCount} of {unitPriceRows.length} unit-price items still unpriced — the contract margin total below reflects priced items only, not the whole
                    contract.
                  </NotificationBanner>
                )}

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
                      <TH align="right" style={{ width: 130 }}>
                        Cost / unit
                      </TH>
                      <TH align="right" style={{ width: 130 }}>
                        Unit Price
                      </TH>
                      <TH align="right">Contract margin</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((row, i) => {
                      const draft = drafts.get(row.item.id) ?? { cost: '', unitPrice: '' }
                      return (
                        <Fragment key={row.item.id}>
                          <TR className={row.unitPriced && !row.priced ? 'bg-nc-secondary/60' : undefined}>
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
                            <TD align="right" dense={row.unitPriced}>
                              {row.unitPriced ? (
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
                              ) : (
                                <span className="text-nc-text-muted">—</span>
                              )}
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
                        Contract margin ({pricedCount} of {unitPriceRows.length} unit-price items priced)
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
