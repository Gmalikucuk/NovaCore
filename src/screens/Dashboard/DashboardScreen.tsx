import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { MyProject } from '../../lib/supabase/projects'
import { fetchLineItems, type LineItem } from '../../lib/supabase/lineItems'
import { fetchLineItemPrices, type LineItemPrice } from '../../lib/supabase/prices'
import { fetchEffectiveQuantities } from '../../lib/supabase/dashboard'
import { placedToDateByItem, percentComplete } from '../../lib/calculations/lineItemProgress'
import { margin, marginPercent } from '../../lib/calculations/margin'
import { concentrationByValue } from '../../lib/calculations/concentration'
import { sensitivityExposure } from '../../lib/calculations/sensitivity'
import { errorMessage } from '../../lib/errorMessage'
import './DashboardScreen.css'

const FINANCE_ROLES = ['project_manager', 'cfo', 'owner']

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
  item: LineItem
  placed: number
  remaining: number
  percent: number | null
  cost: number | null
  sell: number | null
  costToDate: number | null
  revenueToDate: number | null
  marginToDate: number | null
  marginPct: number | null
}

export function DashboardScreen() {
  const project = useOutletContext<MyProject>()
  const showFinance = FINANCE_ROLES.includes(project.role)

  const [items, setItems] = useState<LineItem[]>([])
  const [prices, setPrices] = useState<LineItemPrice[]>([])
  const [placedMap, setPlacedMap] = useState<Map<string, number>>(new Map())
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [driftPerUnit, setDriftPerUnit] = useState(1)
  const [overrunPercent, setOverrunPercent] = useState(2)

  useEffect(() => {
    setStatus('loading')
    // field has no RLS grant on line_item_prices at all (0002) — the finance
    // wall is structural, so this branch is a courtesy (skip a call that
    // would just come back empty), not the thing actually enforcing it.
    Promise.all([fetchLineItems(project.id), showFinance ? fetchLineItemPrices(project.id) : Promise.resolve([]), fetchEffectiveQuantities(project.id)])
      .then(([liRows, priceRows, effectiveRows]) => {
        setItems(liRows)
        setPrices(priceRows)
        setPlacedMap(placedToDateByItem(effectiveRows))
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [project.id, showFinance])

  const priceByItem = useMemo(() => new Map(prices.map((p) => [p.lineItemId, p])), [prices])

  const rows: Row[] = useMemo(
    () =>
      items.map((item) => {
        const placed = placedMap.get(item.id) ?? 0
        const price = priceByItem.get(item.id)
        const cost = price?.costPrice ?? null
        const sell = price?.sellPrice ?? null
        return {
          item,
          placed,
          remaining: item.bidQuantity - placed,
          percent: percentComplete(placed, item.bidQuantity, item.unit),
          cost,
          sell,
          costToDate: cost !== null ? placed * cost : null,
          revenueToDate: sell !== null ? placed * sell : null,
          marginToDate: margin(placed, cost, sell),
          marginPct: marginPercent(placed, cost, sell),
        }
      }),
    [items, placedMap, priceByItem],
  )

  const totals = useMemo(() => {
    const costToDate = rows.reduce((s, r) => s + (r.costToDate ?? 0), 0)
    const revenueToDate = rows.reduce((s, r) => s + (r.revenueToDate ?? 0), 0)
    const marginToDate = rows.reduce((s, r) => s + (r.marginToDate ?? 0), 0)
    const pricedCount = rows.filter((r) => r.cost !== null && r.sell !== null).length
    return { costToDate, revenueToDate, marginToDate, pricedCount, total: rows.length }
  }, [rows])

  // Concentration and sensitivity need only tendered quantity and rates —
  // true on day one of the contract, before anything is placed. Priced
  // items only: an unpriced item has no defined contract value to rank by.
  const pricedForAnalysis = useMemo(
    () =>
      rows
        .filter((r): r is Row & { cost: number; sell: number } => r.cost !== null && r.sell !== null)
        .map((r) => ({
          itemNo: r.item.itemNo,
          description: r.item.description,
          quantity: r.item.bidQuantity,
          cost: r.cost,
          sell: r.sell,
          contractValue: r.item.bidQuantity * r.sell,
          contractMargin: margin(r.item.bidQuantity, r.cost, r.sell) ?? 0,
        })),
    [rows],
  )

  const concentration = useMemo(
    () => concentrationByValue(pricedForAnalysis.map((r) => ({ itemNo: r.itemNo, value: r.contractValue }))),
    [pricedForAnalysis],
  )
  const topThreeShare = concentration.length >= 3 ? concentration[2].cumulativeShare : concentration.at(-1)?.cumulativeShare ?? null
  const contractValueTotal = pricedForAnalysis.reduce((s, r) => s + r.contractValue, 0)

  const sensitivity = useMemo(
    () =>
      sensitivityExposure(
        pricedForAnalysis.map((r) => ({ itemNo: r.itemNo, quantity: r.quantity, costPrice: r.cost, contractMargin: r.contractMargin })),
        driftPerUnit,
        overrunPercent / 100,
      ).sort((a, b) => b.quantity - a.quantity),
    [pricedForAnalysis, driftPerUnit, overrunPercent],
  )
  const sensitivityTotals = useMemo(
    () => ({
      drift: sensitivity.reduce((s, r) => s + r.driftExposure, 0),
      overrun: sensitivity.reduce((s, r) => s + r.overrunExposure, 0),
      combined: sensitivity.reduce((s, r) => s + r.combinedExposure, 0),
    }),
    [sensitivity],
  )

  if (status === 'loading') return <p className="dashboard-status">Loading…</p>
  if (status === 'error') return <p className="dashboard-error">{loadError}</p>

  return (
    <div className="dashboard-screen">
      <h1 className="dashboard-title">Dashboard — {project.name}</h1>

      {showFinance && (
        <p className="dashboard-credibility">
          <strong>Revenue here is placed quantity × sell rate.</strong> That is an internal expectation, not Ministry-approved payment.
          The gap between what is placed, what is approved, and what is paid is real and is not modelled — quantities come from
          confirmed field entries only, and a superseded entry stops counting only once its replacement is confirmed.
        </p>
      )}

      <div className="dashboard-stats">
        <div className="dashboard-stat">
          <div className="dashboard-stat-label">Line items</div>
          <div className="dashboard-stat-value">{items.length}</div>
        </div>
        {showFinance && (
          <>
            <div className="dashboard-stat">
              <div className="dashboard-stat-label">Cost to date</div>
              <div className="dashboard-stat-value">{money(totals.costToDate)}</div>
              <div className="dashboard-stat-sub">{totals.pricedCount} of {totals.total} items priced</div>
            </div>
            <div className="dashboard-stat">
              <div className="dashboard-stat-label">Revenue to date</div>
              <div className="dashboard-stat-value">{money(totals.revenueToDate)}</div>
            </div>
            <div className="dashboard-stat">
              <div className="dashboard-stat-label">Margin to date</div>
              <div className={`dashboard-stat-value ${totals.marginToDate < 0 ? 'dashboard-negative' : ''}`}>{money(totals.marginToDate)}</div>
            </div>
            {topThreeShare !== null && (
              <div className="dashboard-stat">
                <div className="dashboard-stat-label">Top 3 items</div>
                <div className="dashboard-stat-value dashboard-warn">{pct(topThreeShare, 0)}</div>
                <div className="dashboard-stat-sub">of priced contract value</div>
              </div>
            )}
          </>
        )}
      </div>

      <table className="dashboard-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Description</th>
            <th>Unit</th>
            <th className="dashboard-col-right">Contract qty</th>
            <th className="dashboard-col-right">Placed to date</th>
            <th className="dashboard-col-right">Remaining</th>
            <th className="dashboard-col-right">% complete</th>
            {showFinance && (
              <>
                <th className="dashboard-col-right">Cost / unit</th>
                <th className="dashboard-col-right">Sell / unit</th>
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
              <td className="dashboard-mono">{r.item.itemNo}</td>
              <td>{r.item.description}</td>
              <td>{r.item.unit}</td>
              <td className="dashboard-col-right dashboard-mono">{num(r.item.bidQuantity, 1)}</td>
              <td className="dashboard-col-right dashboard-mono">{num(r.placed, 1)}</td>
              <td className="dashboard-col-right dashboard-mono">{num(r.remaining, 1)}</td>
              <td className="dashboard-col-right dashboard-mono">{pct(r.percent)}</td>
              {showFinance && (
                <>
                  <td className="dashboard-col-right dashboard-mono">{money(r.cost, 2)}</td>
                  <td className="dashboard-col-right dashboard-mono">{money(r.sell, 2)}</td>
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
                Project totals — quantity columns aren't summed above (mixed units across items); the $ columns are.
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
        <>
          <section className="dashboard-section">
            <h2 className="dashboard-section-title">Where the money is</h2>
            <p className="dashboard-section-body">
              {concentration.length >= 3 &&
                `${pct(topThreeShare, 0)} of priced contract value sits in three line items — ${concentration
                  .slice(0, 3)
                  .map((r) => r.itemNo)
                  .join(', ')}. Estimating precision on the remaining ${pricedForAnalysis.length - 3} priced items can't move the
                outcome the way a small error in these three can.`}
            </p>
            <div className="dashboard-concentration-bar">
              {concentration.slice(0, 12).map((r, i) => {
                const width = contractValueTotal > 0 ? (r.value / contractValueTotal) * 100 : 0
                return (
                  <div
                    key={r.itemNo}
                    className={i < 3 ? 'dashboard-concentration-seg dashboard-concentration-seg-top' : 'dashboard-concentration-seg'}
                    style={{ width: `${width}%` }}
                    title={`${r.itemNo} — ${money(r.value)}`}
                  >
                    {width > 7 && r.itemNo}
                  </div>
                )
              })}
            </div>
            <table className="dashboard-table dashboard-table-compact">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Description</th>
                  <th className="dashboard-col-right">Contract value</th>
                  <th className="dashboard-col-right">Margin</th>
                  <th className="dashboard-col-right">Cumulative share</th>
                </tr>
              </thead>
              <tbody>
                {concentration.map((r, i) => {
                  const detail = pricedForAnalysis.find((p) => p.itemNo === r.itemNo)
                  return (
                    <tr key={r.itemNo} className={i < 3 ? 'dashboard-row-top' : undefined}>
                      <td className="dashboard-mono">{r.itemNo}</td>
                      <td>{detail?.description}</td>
                      <td className="dashboard-col-right dashboard-mono">{money(r.value)}</td>
                      <td className="dashboard-col-right dashboard-mono">{money(detail?.contractMargin ?? null)}</td>
                      <td className="dashboard-col-right dashboard-mono">{pct(r.cumulativeShare, 0)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>

          <section className="dashboard-section">
            <h2 className="dashboard-section-title">What drift costs</h2>
            <p className="dashboard-section-body">
              If unit cost comes in above estimate, what does that cost? If more quantity is placed than tendered without a change
              order, what does that cost? Both scale with quantity, so both concentrate in the same few items above. Overrun is
              modelled as cost incurred with no revenue against it — where a change order exists, this overstates the risk.
            </p>
            <div className="dashboard-sliders">
              <label className="dashboard-slider">
                <span>Cost drift per unit — {money(driftPerUnit, 2)}</span>
                <input type="range" min="0.25" max="5" step="0.25" value={driftPerUnit} onChange={(e) => setDriftPerUnit(Number(e.target.value))} />
              </label>
              <label className="dashboard-slider">
                <span>Quantity overrun — {overrunPercent}%</span>
                <input type="range" min="0.5" max="10" step="0.5" value={overrunPercent} onChange={(e) => setOverrunPercent(Number(e.target.value))} />
              </label>
            </div>
            <table className="dashboard-table dashboard-table-compact">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="dashboard-col-right">Quantity</th>
                  <th className="dashboard-col-right">Drift exposure</th>
                  <th className="dashboard-col-right">Overrun exposure</th>
                  <th className="dashboard-col-right">Combined</th>
                </tr>
              </thead>
              <tbody>
                {sensitivity.map((r) => (
                  <tr key={r.itemNo}>
                    <td className="dashboard-mono">{r.itemNo}</td>
                    <td className="dashboard-col-right dashboard-mono">{num(r.quantity)}</td>
                    <td className="dashboard-col-right dashboard-mono dashboard-negative">−{money(r.driftExposure)}</td>
                    <td className="dashboard-col-right dashboard-mono dashboard-negative">−{money(r.overrunExposure)}</td>
                    <td className="dashboard-col-right dashboard-mono dashboard-negative">
                      −{money(r.combinedExposure)}
                      {r.exceedsMargin && <div className="dashboard-exceeds-margin">exceeds this item's margin</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2} className="dashboard-totals-label">
                    Total exposure
                  </td>
                  <td className="dashboard-col-right dashboard-mono dashboard-negative dashboard-totals-value">−{money(sensitivityTotals.drift)}</td>
                  <td className="dashboard-col-right dashboard-mono dashboard-negative dashboard-totals-value">−{money(sensitivityTotals.overrun)}</td>
                  <td className="dashboard-col-right dashboard-mono dashboard-negative dashboard-totals-value">−{money(sensitivityTotals.combined)}</td>
                </tr>
              </tfoot>
            </table>
          </section>
        </>
      )}
    </div>
  )
}
