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
import { Button, NotificationBanner, PageHeader, Spinner, StatCard, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

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

  const subtitle = `${contract.name}${status === 'ready' ? ` · ${items.length} item${items.length === 1 ? '' : 's'}` : ''}`

  return (
    <div>
      <PageHeader title="Dashboard" subtitle={subtitle} />

      {status === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-nc-text-muted">
          <Spinner />
          <span className="text-sm">Loading…</span>
        </div>
      )}
      {status === 'error' && loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}

      {status === 'ready' && (
        <>
          {showFinance && (
            <NotificationBanner tone="navy" className="mb-4 leading-relaxed">
              <strong>Revenue here is placed quantity × Unit Price.</strong> That is an internal expectation, not a Ministry-approved
              progress estimate. The gap between what is placed, what is approved, and what is paid is real and is not modelled —
              quantities come from confirmed field entries only, and a superseded entry stops counting only once its replacement is
              confirmed.
            </NotificationBanner>
          )}

          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Items" value={items.length} />
            {showFinance && (
              <>
                <StatCard label="Cost to date" value={money(totals.costToDate)} sub={`${totals.pricedCount} of ${totals.total} items priced`} />
                <StatCard label="Revenue to date" value={money(totals.revenueToDate)} />
                <StatCard label="Margin to date" value={<span className={totals.marginToDate < 0 ? 'text-nc-danger-text' : undefined}>{money(totals.marginToDate)}</span>} />
              </>
            )}
          </div>

          <Table className="mb-6">
            <THead>
              <TR>
                <TH>Item #</TH>
                <TH>Description</TH>
                <TH>Unit of Measure</TH>
                <TH align="right">Approximate Quantity</TH>
                <TH align="right">Quantity to Date</TH>
                <TH align="right">Remaining</TH>
                <TH align="right">% complete</TH>
                {showFinance && (
                  <>
                    <TH align="right">Cost / unit</TH>
                    <TH align="right">Unit Price</TH>
                    <TH align="right">Cost to date</TH>
                    <TH align="right">Revenue to date</TH>
                    <TH align="right">Margin</TH>
                    <TH align="right">Margin %</TH>
                  </>
                )}
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.item.id}>
                  <TD className="nc-numeric">{r.item.itemNumber}</TD>
                  <TD prose>{r.item.description}</TD>
                  <TD>{r.item.unit}</TD>
                  <TD align="right" className="nc-numeric">
                    {num(r.item.approximateQuantity, 1)}
                  </TD>
                  <TD align="right" className="nc-numeric">
                    {num(r.placed, 1)}
                  </TD>
                  <TD align="right" className="nc-numeric">
                    {num(r.remaining, 1)}
                  </TD>
                  <TD align="right" className="nc-numeric">
                    {pct(r.percent)}
                  </TD>
                  {showFinance && (
                    <>
                      <TD align="right" className="nc-numeric">
                        {money(r.cost, 2)}
                      </TD>
                      <TD align="right" className="nc-numeric">
                        {money(r.unitPrice, 2)}
                      </TD>
                      <TD align="right" className="nc-numeric">
                        {money(r.costToDate)}
                      </TD>
                      <TD align="right" className="nc-numeric">
                        {money(r.revenueToDate)}
                      </TD>
                      <TD align="right" className={`nc-numeric ${r.marginToDate !== null && r.marginToDate < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
                        {money(r.marginToDate)}
                      </TD>
                      <TD align="right" className="nc-numeric">
                        {pct(r.marginPct)}
                      </TD>
                    </>
                  )}
                </TR>
              ))}
            </TBody>
            {showFinance && (
              <tfoot>
                <tr>
                  <td colSpan={9} className="text-data border-t border-nc-border bg-nc-secondary px-4 py-3 text-xs text-nc-text-muted">
                    Contract totals — quantity columns aren't summed above (mixed units across items); the $ columns are.
                  </td>
                  <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold text-nc-text">{money(totals.costToDate)}</td>
                  <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold text-nc-text">{money(totals.revenueToDate)}</td>
                  <td
                    className={`text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold ${totals.marginToDate < 0 ? 'text-nc-danger-text' : 'text-nc-text'}`}
                  >
                    {money(totals.marginToDate)}
                  </td>
                  <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold text-nc-text">
                    {totals.revenueToDate > 0 ? pct(totals.marginToDate / totals.revenueToDate) : '—'}
                  </td>
                </tr>
              </tfoot>
            )}
          </Table>

          {showFinance && pricedForAnalysis.length > 0 && (
            <section className="mb-6">
              <Button type="button" variant="secondary" className="mb-3" onClick={() => setShowConcentration((v) => !v)} aria-expanded={showConcentration}>
                {showConcentration ? 'Hide' : 'Show'} concentration — where the money is
              </Button>

              {showConcentration && (
                <>
                  <h2 className="mb-2 text-lg font-semibold text-nc-text">Where the money is</h2>
                  <p className="mb-4 max-w-3xl text-sm leading-relaxed text-nc-text-muted">
                    {concentration.length >= 3 &&
                      `${pct(topThreeShare, 0)} of priced contract value sits in three items — ${concentration
                        .slice(0, 3)
                        .map((r) => r.itemNumber)
                        .join(', ')}. Estimating precision on the remaining ${pricedForAnalysis.length - 3} priced items can't move the
                      outcome the way a small error in these three can.`}
                  </p>
                  <div className="mb-4 flex h-[34px] overflow-hidden rounded-md border border-nc-border">
                    {concentration.slice(0, 12).map((r, i) => {
                      const width = contractValueTotal > 0 ? (r.value / contractValueTotal) * 100 : 0
                      return (
                        <div
                          key={r.itemNumber}
                          className={`nc-numeric flex items-center justify-center overflow-hidden whitespace-nowrap border-r border-white text-[10px] ${
                            i < 3 ? 'bg-nc-navy font-semibold text-white' : 'bg-nc-border text-nc-text'
                          }`}
                          style={{ width: `${width}%` }}
                          title={`${r.itemNumber} — ${money(r.value)}`}
                        >
                          {width > 7 && r.itemNumber}
                        </div>
                      )
                    })}
                  </div>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Item #</TH>
                        <TH>Description</TH>
                        <TH align="right">Contract value</TH>
                        <TH align="right">Margin</TH>
                        <TH align="right">Cumulative share</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {concentration.map((r, i) => {
                        const detail = pricedForAnalysis.find((p) => p.itemNumber === r.itemNumber)
                        return (
                          <TR key={r.itemNumber} className={i < 3 ? 'bg-nc-info-bg/50' : undefined}>
                            <TD className="nc-numeric">{r.itemNumber}</TD>
                            <TD prose>{detail?.description}</TD>
                            <TD align="right" className="nc-numeric">
                              {money(r.value)}
                            </TD>
                            <TD align="right" className="nc-numeric">
                              {money(detail?.contractMargin ?? null)}
                            </TD>
                            <TD align="right" className="nc-numeric">
                              {pct(r.cumulativeShare, 0)}
                            </TD>
                          </TR>
                        )
                      })}
                    </TBody>
                  </Table>
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}
