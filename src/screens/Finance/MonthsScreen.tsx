import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, type ItemPrice } from '../../lib/supabase/prices'
import { fetchContractMonths, fetchItemMonths, type ContractMonth, type ItemMonth } from '../../lib/supabase/monthlyPeriods'
import { fetchLastConfirmedAt } from '../../lib/supabase/quantityRecords'
import { formatMonthLabel, monthKeyFromDate, monthKeyToPeriod } from '../../lib/calculations/overview'
import { costTrackingVisible } from '../../lib/calculations/margin'
import { formatConfirmedAt } from '../../lib/dateFormat'
import { errorMessage } from '../../lib/errorMessage'
import { rate } from '../../lib/format'
import { NotificationBanner, PageHeader, SandboxBanner, Spinner } from '../../components/ui'

// The curve of the contract at a glance — a filled track scaled against the
// largest month on THIS list, so June/July reading as substantial and
// August as small (Venables' real production profile) is visible without
// reading twelve numbers. A tiny nonzero floor keeps a genuinely small-but-
// real month visible as a sliver rather than vanishing entirely.
function ValueBar({ value, maxValue }: { value: number | null; maxValue: number }) {
  const pct = value !== null && maxValue > 0 && value > 0 ? Math.max((value / maxValue) * 100, 3) : 0
  return (
    <div className="relative mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-nc-secondary" aria-hidden="true">
      {pct > 0 && <div className="absolute inset-y-0 left-0 rounded-full bg-nc-accent" style={{ width: `${pct}%` }} />}
    </div>
  )
}

/**
 * "What does that come to" — a compact list of months, most recent first,
 * each opening to its own screen (FinanceMonthScreen: Item detail,
 * drill-down, export). Split out of the old combined Overview screen (which
 * held this alongside Pinned Items/Needs attention, behind a tab) into its
 * own Finance-section route: this needs a Unit Price to mean anything,
 * Progress doesn't.
 *
 * The finance manager's unit of thought is the monthly progress estimate
 * (GC 52.01 puts one in the Ministry Representative's hands within seven
 * days of each month's start), not a wall of Items — that's the detail
 * BEHIND a month, reached by opening one. Status is calendar-only,
 * deliberately, and the word for a past month is "Past" — not "Closed".
 * Records are append-only: a correction confirmed today against an earlier
 * record supersedes its predecessor and changes that month's own figures.
 * "Closed" reads as final to a finance manager; nothing here is.
 */
export function MonthsScreen() {
  const contract = useOutletContext<MyContract>()
  const navigate = useNavigate()

  const [items, setItems] = useState<Item[]>([])
  const [prices, setPrices] = useState<ItemPrice[]>([])
  const [contractMonths, setContractMonths] = useState<ContractMonth[]>([])
  const [itemMonths, setItemMonths] = useState<ItemMonth[]>([])
  const [lastConfirmedAt, setLastConfirmedAt] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const nowMonthKey = useMemo(() => monthKeyFromDate(new Date()), [])

  useEffect(() => {
    setStatus('loading')
    Promise.all([
      fetchItems(contract.id),
      contract.viewRates ? fetchItemPrices(contract.id) : Promise.resolve([]),
      contract.viewRates ? fetchContractMonths(contract.id) : Promise.resolve([]),
      fetchItemMonths(contract.id),
      fetchLastConfirmedAt(contract.id),
    ])
      .then(([itemRows, priceRows, contractMonthRows, itemMonthRows, lastConfirmed]) => {
        setItems(itemRows)
        setPrices(priceRows)
        setContractMonths(contractMonthRows)
        setItemMonths(itemMonthRows)
        setLastConfirmedAt(lastConfirmed)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [contract.id, contract.viewRates])

  const priceByItem = useMemo(() => new Map(prices.map((p) => [p.itemId, p])), [prices])
  const unitPriceItems = useMemo(() => items.filter((i) => i.itemKind === 'unit_price'), [items])
  const hasNoRatesAtAll = contract.viewRates && unitPriceItems.length > 0 && !unitPriceItems.some((i) => priceByItem.get(i.id)?.unitPrice != null)

  // Whether Est. margin has anywhere to be shown at all — same rule Rates
  // now follows: a column that's em-dash on every row because cost
  // tracking is off announces an absence rather than showing one, so it's
  // dropped entirely (header and cells) rather than gated per-cell.
  const costVisible = costTrackingVisible({ costTrackingEnabled: contract.costTrackingEnabled, setCost: contract.setCost })

  const financeMonths = useMemo(() => {
    const keys = new Set(itemMonths.map((m) => m.periodMonth))
    const currentPeriod = monthKeyToPeriod(nowMonthKey)
    keys.add(currentPeriod)
    return [...keys]
      .sort()
      .reverse()
      .map((period) => {
        const [y, m] = period.split('-').map(Number)
        const contractMonth = contractMonths.find((cm) => cm.periodMonth === period)
        return {
          period,
          monthKey: { year: y, month: m },
          isCurrent: period === currentPeriod,
          // Value stays real regardless of cost-tracking visibility — it's
          // price-derived, not cost-derived. Margin is raw here; visibility
          // is decided once, at the column level, by costVisible above.
          value: contractMonth?.valueInPeriod ?? null,
          margin: contractMonth?.marginInPeriod ?? null,
        }
      })
  }, [itemMonths, contractMonths, nowMonthKey])

  const maxMonthValue = useMemo(() => financeMonths.reduce((max, fm) => Math.max(max, fm.value ?? 0), 0), [financeMonths])

  return (
    <div>
      <PageHeader title="Months" subtitle={contract.name} />
      <p className="mb-6 max-w-3xl text-xs text-nc-text-subtle">
        Value of Work is recorded quantity × tendered Unit Price — the Contractor's own measure, not a Ministry-approved progress estimate.
      </p>

      <SandboxBanner contract={contract} variant="quiet" />

      {status === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-nc-text-muted">
          <Spinner />
          <span className="text-sm">Loading…</span>
        </div>
      )}
      {status === 'error' && loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}

      {status === 'ready' && (
        <>
          {hasNoRatesAtAll && (
            <NotificationBanner tone="warning" className="mb-4">
              No Unit Prices are set on this contract yet — every money figure below is empty because no rate has been entered, not because there's no work.
            </NotificationBanner>
          )}

          <section>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Months</h2>
              <p className="text-xs text-nc-text-muted">{lastConfirmedAt ? <>Confirmed records as of {formatConfirmedAt(lastConfirmedAt)}</> : 'No confirmed records yet'}</p>
            </div>
            <div className="flex flex-col divide-y divide-nc-border rounded-lg border border-nc-border bg-white shadow-sm">
              {/* Column heads stated once here rather than repeated on
                  every row (was "Value"/"Est. margin" inside each of
                  twelve-odd rows) — same width as the cells below them
                  (w-28) so the numbers line up under their own label. */}
              {contract.viewRates && (
                <div className="flex items-center justify-between gap-4 px-4 py-2">
                  <span aria-hidden="true" />
                  <div className="flex gap-6">
                    <div className="text-label w-28 text-right text-nc-text-muted">Value</div>
                    {costVisible && <div className="text-label w-28 text-right text-nc-text-muted">Est. margin</div>}
                  </div>
                </div>
              )}
              {financeMonths.map((fm) => (
                <button
                  key={fm.period}
                  type="button"
                  onClick={() => navigate(`/finance/${fm.period}`)}
                  className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-nc-secondary"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-nc-text">{formatMonthLabel(fm.monthKey)}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${fm.isCurrent ? 'bg-nc-info-bg text-nc-info-text' : 'bg-nc-neutral-bg text-nc-neutral-text'}`}>
                      {fm.isCurrent ? 'In progress' : 'Past'}
                    </span>
                  </div>
                  {contract.viewRates && (
                    <div className="flex gap-6">
                      <div className="w-28 text-right">
                        <div className="nc-numeric text-sm font-semibold text-nc-text">{rate(fm.value)}</div>
                        <ValueBar value={fm.value} maxValue={maxMonthValue} />
                      </div>
                      {costVisible && (
                        <div className="w-28 text-right">
                          <div className={`nc-numeric text-sm font-semibold ${fm.margin !== null && fm.margin < 0 ? 'text-nc-danger-text' : 'text-nc-text'}`}>{rate(fm.margin)}</div>
                        </div>
                      )}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
