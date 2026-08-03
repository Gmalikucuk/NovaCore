import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, type ItemPrice } from '../../lib/supabase/prices'
import { fetchEffectiveQuantities } from '../../lib/supabase/dashboard'
import { placedToDateByItem, percentComplete } from '../../lib/calculations/itemProgress'
import { margin, marginPercent } from '../../lib/calculations/margin'
import { concentrationByValue } from '../../lib/calculations/concentration'
import { errorMessage } from '../../lib/errorMessage'
import './DashboardScreen.css'

function money(v: number | null, digits = 0): string {
  if (v === null || Number.isNaN(v)) return '—'
  const sign = v < 0 ? '-$' : '$'
  return sign + Math.abs(v).toLocaleString('en-CA', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
function num(v: number | null, digits = 0): string {
  if (v === null || Number.isNaN(v)) return '—'
  return v.toLocaleString('en-CA', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
function pct(v: number | null, digits = 1): string {
  if (v === null || Number.isNaN(v)) return '—'
  return `${(v * 100).toFixed(digits)}%`
}

interface Row {
  item: Item
  placed: number
  remaining: number
  percent: number | null
  cost: number | null
  unitPrice: number | null
  costToDate: number | null
  revenueToDate: number | null
  marginToDate: number | null
  marginPct: number | null
}

export function DashboardScreen() {
  const contract = useOutletContext<MyContract>()
  // Dashboard nav visibility is unconditional (0008) — this gates the
  // finance columns/credibility banner/concentration view inside the
  // screen, not reachability. Single right, single check: view_rates.
  const showFinance = contract.viewRates

  const [items, setItems] = useState<Item[]>([])
  const [prices, setPrices] = useState<ItemPrice[]>([])
  const [placedMap, setPlacedMap] = useState<Map<string, number>>(new Map())
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showConcentration, setShowConcentration] = useState(false)

  useEffect(() => {
    setStatus('loading')
    // A seat without view_rates has no RLS grant path to item_prices at
    // all (0008's finance wall) — this branch is a courtesy (skip a call
    // that would just come back empty), not the thing actually enforcing it.
    Promise.all([fetchItems(contract.id), showFinance ? fetchItemPrices(contract.id) : Promise.resolve([]), fetchEffectiveQuantities(contract.id)])
      .then(([itemRows, priceRows, effectiveRows]) => {
        setItems(itemRows)
        setPrices(priceRows)
        setPlacedMap(placedToDateByItem(effectiveRows))
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [contract.id, showFinance])

  const priceByItem = useMemo(() => new Map(prices.map((p) => [p.itemId, p])), [prices])

  const rows: Row[] = useMemo(
    () =>
      items.map((item) => {
        const placed = placedMap.get(item.id) ?? 0
        const price = priceByItem.get(item.id)
        const cost = price?.costPrice ?? null
        const unitPrice = price?.unitPrice ?? null
        return {
          item,
          placed,
          remaining: item.approximateQuantity - placed,
          percent: percentComplete(placed, item.approximateQuantity, item.unit),
          cost,
          unitPrice,
          costToDate: cost !== null ? placed * cost : null,
          revenueToDate: unitPrice !== null ? placed * unitPrice : null,
          marginToDate: margin(placed, cost, unitPrice),
          marginPct: marginPercent(placed, cost, unitPrice),
        }
      }),
    [items, placedMap, priceByItem],
  )

  const totals = useMemo(() => {
    const costToDate = rows.reduce((s, r) => s + (r.costToDate ?? 0), 0)
    const revenueToDate = rows.reduce((s, r) => s + (r.revenueToDate ?? 0), 0)
    const marginToDate = rows.reduce((s, r) => s + (r.marginToDate ?? 0), 0)
    const pricedCount = rows.filter((r) => r.cost !== null && r.unitPrice !== null).length
    return { costToDate, revenueToDate, marginToDate, pricedCount, total: rows.length }
  }, [rows])

  // Concentration needs only tendered quantity and rates — true on day one
  // of the contract, before anything is placed. Priced items only: an
  // unpriced item has no defined contract value to rank by.
  const pricedForAnalysis = useMemo(
    () =>
      rows
        .filter((r): r is Row & { cost: number; unitPrice: number } => r.cost !== null && r.unitPrice !== null)
        .map((r) => ({
          itemNumber: r.item.itemNumber,
          description: r.item.description,
          contractValue: r.item.approximateQuantity * r.unitPrice,
          contractMargin: margin(r.item.approximateQuantity, r.cost, r.unitPrice) ?? 0,
        })),
    [rows],
  )

  const concentration = useMemo(
    () => concentrationByValue(pricedForAnalysis.map((r) => ({ itemNumber: r.itemNumber, value: r.contractValue }))),
    [pricedForAnalysis],
  )
  const topThreeShare = concentration.length >= 3 ? concentration[2].cumulativeShare : (concentration.at(-1)?.cumulativeShare ?? null)
  const contractValueTotal = pricedForAnalysis.reduce((s, r) => s + r.contractValue, 0)

  if (status === 'loading') return <p className="dashboard-status">Loading…</p>
  if (status === 'error') return <p className="dashboard-error">{loadError}</p>

  return (
    <div className="dashboard-screen">
      <h1 className="dashboard-title">Dashboard — {contract.name}</h1>

      {showFinance && (
        <p className="dashboard-credibility">
          <strong>Revenue here is placed quantity × Unit Price.</strong> That is an internal expectation, not a Ministry-approved
          progress estimate. The gap between what is placed, what is approved, and what is paid is real and is not modelled —
          quantities come from confirmed field entries only, and a superseded entry stops counting only once its replacement is
          confirmed.
        </p>
      )}

      <div className="dashboard-stats">
        <div className="dashboard-stat">
          <div className="dashboard-stat-label">Items</div>
          <div className="dashboard-stat-value">{items.length}</div>
        </div>
        {showFinance && (
          <>
            <div className="dashboard-stat">
              <div className="dashboard-stat-label">Cost to date</div>
              <div className="dashboard-stat-value">{money(totals.costToDate)}</div>
              <div className="dashboard-stat-sub">
                {totals.pricedCount} of {totals.total} items priced
              </div>
            </div>
            <div className="dashboard-stat">
              <div className="dashboard-stat-label">Revenue to date</div>
              <div className="dashboard-stat-value">{money(totals.revenueToDate)}</div>
            </div>
            <div className="dashboard-stat">
              <div className="dashboard-stat-label">Margin to date</div>
              <div className={`dashboard-stat-value ${totals.marginToDate < 0 ? 'dashboard-negative' : ''}`}>{money(totals.marginToDate)}</div>
            </div>
          </>
        )}
      </div>

      <table className="dashboard-table">
        <thead>
          <tr>
            <th>Item #</th>
            <th>Description</th>
            <th>Unit of Measure</th>
            <th className="dashboard-col-right">Approximate Quantity</th>
            <th className="dashboard-col-right">Quantity to Date</th>
            <th className="dashboard-col-right">Remaining</th>
            <th className="dashboard-col-right">% complete</th>
            {showFinance && (
              <>
                <th className="dashboard-col-right">Cost / unit</th>
                <th className="dashboard-col-right">Unit Price</th>
                <th className="dashboard-col-right">Cost to date</th>
                <th className="dashboard-col-right">Revenue to date</th>
                <th className="dashboard-col-right">Margin</th>
                <th className="dashboard-col-right">Margin %</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.item.id}>
              <td className="dashboard-mono">{r.item.itemNumber}</td>
              <td>{r.item.description}</td>
              <td>{r.item.unit}</td>
              <td className="dashboard-col-right dashboard-mono">{num(r.item.approximateQuantity, 1)}</td>
              <td className="dashboard-col-right dashboard-mono">{num(r.placed, 1)}</td>
              <td className="dashboard-col-right dashboard-mono">{num(r.remaining, 1)}</td>
              <td className="dashboard-col-right dashboard-mono">{pct(r.percent)}</td>
              {showFinance && (
                <>
                  <td className="dashboard-col-right dashboard-mono">{money(r.cost, 2)}</td>
                  <td className="dashboard-col-right dashboard-mono">{money(r.unitPrice, 2)}</td>
                  <td className="dashboard-col-right dashboard-mono">{money(r.costToDate)}</td>
                  <td className="dashboard-col-right dashboard-mono">{money(r.revenueToDate)}</td>
                  <td className={`dashboard-col-right dashboard-mono ${r.marginToDate !== null && r.marginToDate < 0 ? 'dashboard-negative' : ''}`}>
                    {money(r.marginToDate)}
                  </td>
                  <td className="dashboard-col-right dashboard-mono">{pct(r.marginPct)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
        {showFinance && (
          <tfoot>
            <tr>
              <td colSpan={9} className="dashboard-totals-label">
                Contract totals — quantity columns aren't summed above (mixed units across items); the $ columns are.
              </td>
              <td className="dashboard-col-right dashboard-mono dashboard-totals-value">{money(totals.costToDate)}</td>
              <td className="dashboard-col-right dashboard-mono dashboard-totals-value">{money(totals.revenueToDate)}</td>
              <td className={`dashboard-col-right dashboard-mono dashboard-totals-value ${totals.marginToDate < 0 ? 'dashboard-negative' : ''}`}>
                {money(totals.marginToDate)}
              </td>
              <td className="dashboard-col-right dashboard-mono dashboard-totals-value">
                {totals.revenueToDate > 0 ? pct(totals.marginToDate / totals.revenueToDate) : '—'}
              </td>
            </tr>
          </tfoot>
        )}
      </table>

      {showFinance && pricedForAnalysis.length > 0 && (
        <section className="dashboard-section">
          <button type="button" className="dashboard-toggle" onClick={() => setShowConcentration((v) => !v)} aria-expanded={showConcentration}>
            {showConcentration ? 'Hide' : 'Show'} concentration — where the money is
          </button>

          {showConcentration && (
            <>
              <h2 className="dashboard-section-title">Where the money is</h2>
              <p className="dashboard-section-body">
                {concentration.length >= 3 &&
                  `${pct(topThreeShare, 0)} of priced contract value sits in three items — ${concentration
                    .slice(0, 3)
                    .map((r) => r.itemNumber)
                    .join(', ')}. Estimating precision on the remaining ${pricedForAnalysis.length - 3} priced items can't move the
                  outcome the way a small error in these three can.`}
              </p>
              <div className="dashboard-concentration-bar">
                {concentration.slice(0, 12).map((r, i) => {
                  const width = contractValueTotal > 0 ? (r.value / contractValueTotal) * 100 : 0
                  return (
                    <div
                      key={r.itemNumber}
                      className={i < 3 ? 'dashboard-concentration-seg dashboard-concentration-seg-top' : 'dashboard-concentration-seg'}
                      style={{ width: `${width}%` }}
                      title={`${r.itemNumber} — ${money(r.value)}`}
                    >
                      {width > 7 && r.itemNumber}
                    </div>
                  )
                })}
              </div>
              <table className="dashboard-table dashboard-table-compact">
                <thead>
                  <tr>
                    <th>Item #</th>
                    <th>Description</th>
                    <th className="dashboard-col-right">Contract value</th>
                    <th className="dashboard-col-right">Margin</th>
                    <th className="dashboard-col-right">Cumulative share</th>
                  </tr>
                </thead>
                <tbody>
                  {concentration.map((r, i) => {
                    const detail = pricedForAnalysis.find((p) => p.itemNumber === r.itemNumber)
                    return (
                      <tr key={r.itemNumber} className={i < 3 ? 'dashboard-row-top' : undefined}>
                        <td className="dashboard-mono">{r.itemNumber}</td>
                        <td>{detail?.description}</td>
                        <td className="dashboard-col-right dashboard-mono">{money(r.value)}</td>
                        <td className="dashboard-col-right dashboard-mono">{money(detail?.contractMargin ?? null)}</td>
                        <td className="dashboard-col-right dashboard-mono">{pct(r.cumulativeShare, 0)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}
    </div>
  )
}
