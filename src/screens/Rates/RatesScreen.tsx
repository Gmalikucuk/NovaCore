import { Fragment, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, upsertItemPrice, type ItemPrice } from '../../lib/supabase/prices'
import { margin } from '../../lib/calculations/margin'
import { errorMessage } from '../../lib/errorMessage'
import './RatesScreen.css'

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

  // Contract quantity descending by default — the largest few items carry
  // most of a paving contract's value, so a PM entering rates hits them
  // first and can stop there if she wants (see the brief's own reasoning).
  const sorted = useMemo(() => [...items].sort((a, b) => b.approximateQuantity - a.approximateQuantity), [items])

  const rows = useMemo(
    () =>
      sorted.map((item) => {
        const price = prices.get(item.id)
        const cost = price?.costPrice ?? null
        const unitPrice = price?.unitPrice ?? null
        return {
          item,
          cost,
          unitPrice,
          priced: cost !== null && unitPrice !== null,
          contractMargin: margin(item.approximateQuantity, cost, unitPrice),
        }
      }),
    [sorted, prices],
  )

  const pricedCount = rows.filter((r) => r.priced).length
  const totalMargin = rows.reduce((sum, r) => sum + (r.contractMargin ?? 0), 0)

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

  if (!contract.viewRates) {
    return (
      <div className="rates-screen">
        <p className="rates-denied">Viewing rates needs the view_rates right on this contract.</p>
      </div>
    )
  }

  return (
    <div className="rates-screen">
      <h1 className="rates-title">Rates — {contract.name}</h1>

      {status === 'loading' && <p className="rates-status">Loading…</p>}
      {status === 'error' && <p className="rates-error">{loadError}</p>}

      {status === 'ready' && (
        <>
          {!canEdit && <p className="rates-readonly-banner">Read-only — setting rates needs set_cost and set_unit_price on this contract.</p>}
          {pricedCount < rows.length && (
            <p className="rates-unpriced-banner">
              {rows.length - pricedCount} of {rows.length} items still unpriced — the contract margin total below reflects priced items
              only, not the whole contract.
            </p>
          )}

          <table className="rates-table">
            <thead>
              <tr>
                <th>Item #</th>
                <th>Description</th>
                <th className="rates-col-right">Approximate Quantity</th>
                <th className="rates-col-right">Cost / unit</th>
                <th className="rates-col-right">Unit Price</th>
                <th className="rates-col-right">Contract margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const draft = drafts.get(row.item.id) ?? { cost: '', unitPrice: '' }
                return (
                  <Fragment key={row.item.id}>
                    <tr className={row.priced ? undefined : 'rates-row-unpriced'}>
                      <td className="rates-mono">{row.item.itemNumber}</td>
                      <td>{row.item.description}</td>
                      <td className="rates-col-right rates-mono">
                        {row.item.approximateQuantity} <span className="rates-unit">{row.item.unit}</span>
                      </td>
                      <td className="rates-col-right">
                        <input
                          className="rates-input"
                          data-cell={`${i}-cost`}
                          inputMode="decimal"
                          placeholder="—"
                          value={draft.cost}
                          readOnly={!canEdit}
                          onChange={(e) => updateDraft(row.item.id, 'cost', e.target.value)}
                          onBlur={() => void commitRate(row.item, 'cost')}
                          onKeyDown={(e) => handleKeyDown(e, row.item, 'cost', i)}
                        />
                      </td>
                      <td className="rates-col-right">
                        <input
                          className="rates-input"
                          data-cell={`${i}-unitPrice`}
                          inputMode="decimal"
                          placeholder="—"
                          value={draft.unitPrice}
                          readOnly={!canEdit}
                          onChange={(e) => updateDraft(row.item.id, 'unitPrice', e.target.value)}
                          onBlur={() => void commitRate(row.item, 'unitPrice')}
                          onKeyDown={(e) => handleKeyDown(e, row.item, 'unitPrice', i)}
                        />
                      </td>
                      <td className={`rates-col-right rates-mono ${row.contractMargin !== null && row.contractMargin < 0 ? 'rates-negative' : ''}`}>
                        {row.contractMargin === null ? '—' : row.contractMargin.toLocaleString('en-CA', { maximumFractionDigits: 0 })}
                      </td>
                    </tr>
                    {rowError?.id === row.item.id && (
                      <tr>
                        <td colSpan={6} className="rates-row-error">
                          {rowError.message}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className="rates-total-label">
                  Contract margin ({pricedCount} of {rows.length} items priced)
                </td>
                <td className="rates-col-right rates-mono rates-total-value">
                  {totalMargin.toLocaleString('en-CA', { maximumFractionDigits: 0 })}
                </td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </div>
  )
}
