import { Fragment, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { MyProject } from '../../lib/supabase/projects'
import { fetchLineItems, type LineItem } from '../../lib/supabase/lineItems'
import { fetchLineItemPrices, upsertLineItemPrice, type LineItemPrice } from '../../lib/supabase/prices'
import { margin } from '../../lib/calculations/margin'
import { errorMessage } from '../../lib/errorMessage'
import './RatesScreen.css'

interface Draft {
  cost: string
  sell: string
}

function toDraft(price: LineItemPrice | undefined): Draft {
  return { cost: price?.costPrice?.toString() ?? '', sell: price?.sellPrice?.toString() ?? '' }
}

function parseRate(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isNaN(n) ? null : n
}

function focusCell(row: number, field: 'cost' | 'sell') {
  const el = document.querySelector<HTMLInputElement>(`[data-cell="${row}-${field}"]`)
  el?.focus()
  el?.select()
}

export function RatesScreen() {
  const project = useOutletContext<MyProject>()
  const isPm = project.role === 'project_manager'

  const [items, setItems] = useState<LineItem[]>([])
  const [prices, setPrices] = useState<Map<string, LineItemPrice>>(new Map())
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map())
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null)

  useEffect(() => {
    setStatus('loading')
    Promise.all([fetchLineItems(project.id), fetchLineItemPrices(project.id)])
      .then(([liRows, priceRows]) => {
        setItems(liRows)
        const priceMap = new Map(priceRows.map((p) => [p.lineItemId, p]))
        setPrices(priceMap)
        setDrafts(new Map(liRows.map((li) => [li.id, toDraft(priceMap.get(li.id))])))
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [project.id])

  // Contract quantity descending by default — the largest few items carry
  // most of a paving contract's value, so a PM entering rates hits them
  // first and can stop there if she wants (see the brief's own reasoning).
  const sorted = useMemo(() => [...items].sort((a, b) => b.bidQuantity - a.bidQuantity), [items])

  const rows = useMemo(
    () =>
      sorted.map((item) => {
        const price = prices.get(item.id)
        const cost = price?.costPrice ?? null
        const sell = price?.sellPrice ?? null
        return {
          item,
          cost,
          sell,
          priced: cost !== null && sell !== null,
          contractMargin: margin(item.bidQuantity, cost, sell),
        }
      }),
    [sorted, prices],
  )

  const pricedCount = rows.filter((r) => r.priced).length
  const totalMargin = rows.reduce((sum, r) => sum + (r.contractMargin ?? 0), 0)

  function updateDraft(id: string, field: 'cost' | 'sell', value: string) {
    setDrafts((prev) => {
      const next = new Map(prev)
      const current = next.get(id) ?? { cost: '', sell: '' }
      next.set(id, { ...current, [field]: value })
      return next
    })
  }

  async function commitRate(item: LineItem, field: 'cost' | 'sell') {
    const draft = drafts.get(item.id) ?? { cost: '', sell: '' }
    const existing = prices.get(item.id)
    const newCost = field === 'cost' ? parseRate(draft.cost) : (existing?.costPrice ?? null)
    const newSell = field === 'sell' ? parseRate(draft.sell) : (existing?.sellPrice ?? null)
    if (newCost === existing?.costPrice && newSell === existing?.sellPrice) return

    try {
      const saved = await upsertLineItemPrice({
        lineItemId: item.id,
        projectId: project.id,
        costPrice: newCost,
        sellPrice: newSell,
      })
      setPrices((prev) => new Map(prev).set(item.id, saved))
      setDrafts((prev) => new Map(prev).set(item.id, toDraft(saved)))
      if (rowError?.id === item.id) setRowError(null)
    } catch (err) {
      setRowError({ id: item.id, message: errorMessage(err) })
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>, item: LineItem, field: 'cost' | 'sell', rowIndex: number) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    void commitRate(item, field).then(() => {
      if (rowIndex + 1 < rows.length) focusCell(rowIndex + 1, field)
    })
  }

  if (!isPm) {
    return (
      <div className="rates-screen">
        <p className="rates-denied">Rates are entered by the project manager. Nothing to do here for your role.</p>
      </div>
    )
  }

  return (
    <div className="rates-screen">
      <h1 className="rates-title">Rates — {project.name}</h1>

      {status === 'loading' && <p className="rates-status">Loading…</p>}
      {status === 'error' && <p className="rates-error">{loadError}</p>}

      {status === 'ready' && (
        <>
          {pricedCount < rows.length && (
            <p className="rates-unpriced-banner">
              {rows.length - pricedCount} of {rows.length} items still unpriced — the contract margin total below reflects priced items
              only, not the whole contract.
            </p>
          )}

          <table className="rates-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Description</th>
                <th className="rates-col-right">Quantity</th>
                <th className="rates-col-right">Cost / unit</th>
                <th className="rates-col-right">Sell / unit</th>
                <th className="rates-col-right">Contract margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const draft = drafts.get(row.item.id) ?? { cost: '', sell: '' }
                return (
                  <Fragment key={row.item.id}>
                    <tr className={row.priced ? undefined : 'rates-row-unpriced'}>
                      <td className="rates-mono">{row.item.itemNo}</td>
                      <td>{row.item.description}</td>
                      <td className="rates-col-right rates-mono">
                        {row.item.bidQuantity} <span className="rates-unit">{row.item.unit}</span>
                      </td>
                      <td className="rates-col-right">
                        <input
                          className="rates-input"
                          data-cell={`${i}-cost`}
                          inputMode="decimal"
                          placeholder="—"
                          value={draft.cost}
                          onChange={(e) => updateDraft(row.item.id, 'cost', e.target.value)}
                          onBlur={() => void commitRate(row.item, 'cost')}
                          onKeyDown={(e) => handleKeyDown(e, row.item, 'cost', i)}
                        />
                      </td>
                      <td className="rates-col-right">
                        <input
                          className="rates-input"
                          data-cell={`${i}-sell`}
                          inputMode="decimal"
                          placeholder="—"
                          value={draft.sell}
                          onChange={(e) => updateDraft(row.item.id, 'sell', e.target.value)}
                          onBlur={() => void commitRate(row.item, 'sell')}
                          onKeyDown={(e) => handleKeyDown(e, row.item, 'sell', i)}
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
