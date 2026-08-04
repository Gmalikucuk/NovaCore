import { useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconAlertTriangle, IconClockPause, IconFlag, IconMinus, IconTrendingDown, IconTrendingUp } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, type ItemPrice } from '../../lib/supabase/prices'
import { fetchContractMonths, fetchItemMonths, fetchItemProgressRate, type ContractMonth, type ItemMonth, type ItemProgressRate } from '../../lib/supabase/monthlyPeriods'
import {
  BEHIND_RATE_THRESHOLD_DAYS,
  buildProblemList,
  formatMonthLabel,
  itemsInProgress,
  monthDirection,
  monthKeyFromDate,
  monthKeyToPeriod,
  previousMonth,
  weightedCompletion,
  type Direction,
  type MonthKey,
  type ProblemItem,
} from '../../lib/calculations/overview'
import { margin as computeMargin, sumOrNull } from '../../lib/calculations/margin'
import { errorMessage } from '../../lib/errorMessage'
import { money, percent, quantity as fmtQuantity } from '../../lib/format'
import { Button, Card, NotificationBanner, PageHeader, Select, Spinner, StatCard, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

const ATTENTION_CAP = 5

function DirectionBadge({ direction, sameIsGood }: { direction: Direction; sameIsGood?: boolean }) {
  if (direction === 'flat') return <IconMinus size={14} stroke={2} className="inline text-nc-text-muted" />
  const good = direction === 'up'
  const Icon = good ? IconTrendingUp : IconTrendingDown
  return <Icon size={14} stroke={2} className={`inline ${good || sameIsGood === false ? 'text-nc-success-text' : 'text-nc-danger-text'}`} />
}

function problemSentence(p: ProblemItem, costByItem: Map<string, number | null>): string {
  const { kind, row } = p
  if (kind === 'stalled') {
    return row.lastWorkDate ? `No activity since ${row.lastWorkDate} — not finished.` : 'No confirmed activity yet — not finished.'
  }
  if (kind === 'over_quantity') {
    const overage = row.quantityToDate - row.approximateQuantity
    const cost = costByItem.get(row.itemId) ?? null
    const atCost = cost !== null ? ` — ${money(overage * cost)} at cost` : ''
    return `${fmtQuantity(overage)} ${row.unit} over the Approximate Quantity${atCost}.`
  }
  // behind_rate — flagged past BEHIND_RATE_THRESHOLD_DAYS; named here so
  // the flag doesn't read as an unexplained number, since there's no
  // season-end date in the schema to compare against instead (see
  // overview.ts).
  return `At the recent rate, ~${row.workingDaysRemaining} more working days needed — flagged past ${BEHIND_RATE_THRESHOLD_DAYS}.`
}

const PROBLEM_KIND_LABEL: Record<ProblemItem['kind'], string> = {
  stalled: 'Stalled',
  over_quantity: 'Over quantity',
  behind_rate: 'Behind rate',
}

function ProblemIcon({ kind }: { kind: ProblemItem['kind'] }) {
  if (kind === 'stalled') return <IconClockPause size={16} stroke={1.75} className="text-nc-warning-text" />
  if (kind === 'over_quantity') return <IconAlertTriangle size={16} stroke={1.75} className="text-nc-over-text" />
  return <IconFlag size={16} stroke={1.75} className="text-nc-info-text" />
}

type MonthView = 'period' | 'to-date'
type OverviewTab = 'progress' | 'finance'

/**
 * `contract` is an optional override for the one caller that isn't reached
 * through Sidebar's nested `<Outlet context={contract}>` — FieldHeader
 * renders this directly (in place of EntryScreen) for a phone user with no
 * field-entry rights, and at that point in the tree useOutletContext()
 * would resolve to AuthGate's CurrentContractState, not a MyContract. Every
 * other caller (the /overview route) passes nothing and falls back to the
 * outlet context exactly as before.
 */
export function OverviewScreen({ contract: contractProp }: { contract?: MyContract } = {}) {
  const outletContract = useOutletContext<MyContract>()
  const contract = contractProp ?? outletContract

  const [items, setItems] = useState<Item[]>([])
  const [prices, setPrices] = useState<ItemPrice[]>([])
  const [contractMonths, setContractMonths] = useState<ContractMonth[]>([])
  const [itemMonths, setItemMonths] = useState<ItemMonth[]>([])
  const [progressRate, setProgressRate] = useState<ItemProgressRate[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const nowMonthKey = useMemo(() => monthKeyFromDate(new Date()), [])
  const [selectedMonth, setSelectedMonth] = useState<MonthKey>(nowMonthKey)
  const [monthView, setMonthView] = useState<MonthView>('period')
  const [attentionExpanded, setAttentionExpanded] = useState(false)
  // "How far along are we" vs "what does that come to" — the split is by
  // question, not by role (the PM's own work already lives in Confirm/Daily
  // Entry, not here). One tab visible at a time, on every viewport size —
  // not a mobile-only collapse, an actual navigational split.
  const [activeTab, setActiveTab] = useState<OverviewTab>('progress')
  // Fires once, the first time real data lands — so the month selector
  // opens on the latest month with any records instead of sitting on
  // today's (likely empty-so-far) calendar month, without fighting a user
  // who's since picked a different month themselves.
  const hasAutoSelectedMonth = useRef(false)

  useEffect(() => {
    setStatus('loading')
    // view_rates gates item_prices and v_contract_month by construction
    // (both join item_prices) — skipping the call for a seat that would
    // just get zero rows back is a courtesy, not what's actually enforcing
    // the finance wall.
    Promise.all([
      fetchItems(contract.id),
      contract.viewRates ? fetchItemPrices(contract.id) : Promise.resolve([]),
      contract.viewRates ? fetchContractMonths(contract.id) : Promise.resolve([]),
      fetchItemMonths(contract.id),
      fetchItemProgressRate(contract.id),
    ])
      .then(([itemRows, priceRows, contractMonthRows, itemMonthRows, progressRows]) => {
        setItems(itemRows)
        setPrices(priceRows)
        setContractMonths(contractMonthRows)
        setItemMonths(itemMonthRows)
        setProgressRate(progressRows)
        setStatus('ready')

        if (!hasAutoSelectedMonth.current && itemMonthRows.length > 0) {
          hasAutoSelectedMonth.current = true
          const latestPeriod = [...new Set(itemMonthRows.map((m) => m.periodMonth))].sort().reverse()[0]
          const [y, m] = latestPeriod.split('-').map(Number)
          setSelectedMonth({ year: y, month: m })
        }
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [contract.id, contract.viewRates])

  const priceByItem = useMemo(() => new Map(prices.map((p) => [p.itemId, p])), [prices])
  const progressByItem = useMemo(() => new Map(progressRate.map((p) => [p.itemId, p])), [progressRate])
  const costByItem = useMemo(() => new Map(prices.map((p) => [p.itemId, p.costPrice])), [prices])

  // Band 1 — progress. weightedCompletion/itemsInProgress both read
  // progressRate directly (v_item_progress_rate, already unit_price-only).
  const contractComplete = useMemo(() => weightedCompletion(progressRate), [progressRate])
  const inProgress = useMemo(() => itemsInProgress(progressRate), [progressRate])

  // Band 2 — needs attention, worst-consequence-first (buildProblemList's
  // own ranking); capped here, not in the pure function, so "N more" can
  // report against the true total.
  const problemList = useMemo(() => buildProblemList(progressRate, new Date()), [progressRate])
  const visibleProblems = attentionExpanded ? problemList : problemList.slice(0, ATTENTION_CAP)
  const hiddenProblemCount = problemList.length - visibleProblems.length

  // Band 3 — money. Deliberately keyed to the actual current calendar
  // month (nowMonthKey), not Band 4's selectedMonth — this is "how are we
  // doing right now," independent of whatever month is being inspected in
  // the table below.
  const currentContractMonth = contractMonths.find((m) => m.periodMonth === monthKeyToPeriod(nowMonthKey))
  const previousContractMonth = contractMonths.find((m) => m.periodMonth === monthKeyToPeriod(previousMonth(nowMonthKey)))
  const valueThisMonth = currentContractMonth?.valueInPeriod ?? 0
  const valueLastMonth = previousContractMonth?.valueInPeriod ?? 0
  const marginThisMonth = currentContractMonth?.marginInPeriod ?? 0
  const marginLastMonth = previousContractMonth?.marginInPeriod ?? 0

  // Band 4 — month detail table.
  const availableMonths = useMemo(() => {
    const keys = new Set(itemMonths.map((m) => m.periodMonth))
    keys.add(monthKeyToPeriod(nowMonthKey))
    return [...keys].sort().reverse()
  }, [itemMonths, nowMonthKey])

  const selectedPeriod = monthKeyToPeriod(selectedMonth)
  const itemMonthByItem = useMemo(() => new Map(itemMonths.filter((m) => m.periodMonth === selectedPeriod).map((m) => [m.itemId, m])), [itemMonths, selectedPeriod])

  const monthRows = useMemo(
    () =>
      items.map((item) => {
        const inPeriod = itemMonthByItem.get(item.id)
        const price = priceByItem.get(item.id)
        const progress = progressByItem.get(item.id)
        const unitPriced = item.itemKind === 'unit_price'
        const quantityInPeriod = unitPriced ? (inPeriod?.quantityInPeriod ?? 0) : null
        const cost = unitPriced ? (price?.costPrice ?? null) : null
        const unitPrice = unitPriced ? (price?.unitPrice ?? null) : null
        return {
          item,
          quantityInPeriod,
          valueInPeriod: unitPrice !== null && quantityInPeriod !== null ? quantityInPeriod * unitPrice : null,
          costInPeriod: cost !== null && quantityInPeriod !== null ? quantityInPeriod * cost : null,
          marginInPeriod: unitPriced ? computeMargin(quantityInPeriod ?? 0, cost, unitPrice) : null,
          quantityToDate: unitPriced ? (progress?.quantityToDate ?? 0) : null,
          approximateQuantity: unitPriced ? item.approximateQuantity : null,
          remaining: unitPriced ? item.approximateQuantity - (progress?.quantityToDate ?? 0) : null,
          proportionComplete: unitPriced ? (progress?.proportionComplete ?? null) : null,
          isOverQuantity: unitPriced ? (progress?.isOverQuantity ?? false) : false,
        }
      }),
    [items, itemMonthByItem, priceByItem, progressByItem],
  )

  const monthTotals = useMemo(
    () => ({
      value: sumOrNull(monthRows.map((r) => r.valueInPeriod)),
      cost: sumOrNull(monthRows.map((r) => r.costInPeriod)),
      margin: sumOrNull(monthRows.map((r) => r.marginInPeriod)),
    }),
    [monthRows],
  )

  const unitPriceItems = useMemo(() => items.filter((i) => i.itemKind === 'unit_price'), [items])
  const hasNoRatesAtAll = contract.viewRates && unitPriceItems.length > 0 && !unitPriceItems.some((i) => priceByItem.get(i.id)?.unitPrice != null)

  return (
    <div>
      <PageHeader title="Overview" subtitle={contract.name} />
      <p className="mb-6 max-w-3xl text-xs text-nc-text-subtle">
        Value of Work is recorded quantity × tendered Unit Price — the Contractor's own measure, not a Ministry-approved progress estimate.
      </p>

      {contract.isSandbox && (
        <NotificationBanner tone="danger" className="mb-4 font-medium">
          This is a sandbox contract for exercising every screen state — {contract.name} is not a real contract, and its Unit Prices are invented, not tendered figures.
        </NotificationBanner>
      )}

      {status === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-nc-text-muted">
          <Spinner />
          <span className="text-sm">Loading…</span>
        </div>
      )}
      {status === 'error' && loadError && <NotificationBanner tone="danger">{loadError}</NotificationBanner>}

      {status === 'ready' && (
        <>
          {/* The split is by question, not by role — "how far along are we"
              (Progress) versus "what does that come to" (Finance). One
              visible at a time, at every viewport size: this is real
              navigation, not a mobile-only collapse of one long page. */}
          <div className="mb-6 flex gap-2" role="group" aria-label="Overview section">
            <Button type="button" variant={activeTab === 'progress' ? 'primary' : 'secondary'} onClick={() => setActiveTab('progress')}>
              Progress
            </Button>
            <Button type="button" variant={activeTab === 'finance' ? 'primary' : 'secondary'} onClick={() => setActiveTab('finance')}>
              Finance
            </Button>
          </div>

          {activeTab === 'progress' && (
            <>
              {/* Band 1 — progress, the owner's question: are we on pace
                  against the contract. Largest type on the page, top, no
                  scrolling required, single column on a phone. */}
              <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Card className="p-6">
                  <div className="text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Contract complete</div>
                  <div className="nc-numeric mt-2 text-4xl font-semibold text-nc-text sm:text-5xl">{percent(contractComplete)}</div>
                  <div className="mt-1 text-xs text-nc-text-muted">Quantity-weighted, Unit Price Items</div>
                </Card>
                <Card className="p-6">
                  <div className="text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Items in progress</div>
                  <div className="nc-numeric mt-2 text-4xl font-semibold text-nc-text sm:text-5xl">
                    {inProgress.started} <span className="text-2xl text-nc-text-muted sm:text-3xl">of {inProgress.total}</span>
                  </div>
                  <div className="mt-1 text-xs text-nc-text-muted">Started, not yet finished</div>
                </Card>
              </div>

              {/* Band 2 — what's wrong, worst consequence first: over
                  quantity (cost exposure), then behind rate, then stalled. */}
              <section className="mb-8">
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Needs attention</h2>
                {problemList.length === 0 ? (
                  <p className="text-sm text-nc-text">Every Unit Price Item is progressing normally — nothing over quantity, nothing behind the recent rate, nothing stalled.</p>
                ) : (
                  <>
                    <div className="flex flex-col divide-y divide-nc-border rounded-lg border border-nc-border bg-white shadow-sm">
                      {visibleProblems.map((p) => (
                        <div key={`${p.kind}-${p.row.itemId}`} className="flex items-start gap-3 px-4 py-3">
                          <ProblemIcon kind={p.kind} />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm">
                              <span className="nc-numeric font-semibold text-nc-text">{p.row.itemNumber}</span>{' '}
                              <span className="text-nc-text-muted">{p.row.description}</span>
                            </p>
                            <p className="text-sm text-nc-text-muted">{problemSentence(p, costByItem)}</p>
                          </div>
                          <span className="shrink-0 rounded-full bg-nc-secondary px-2 py-0.5 text-xs font-medium text-nc-text-muted">{PROBLEM_KIND_LABEL[p.kind]}</span>
                        </div>
                      ))}
                    </div>
                    {hiddenProblemCount > 0 && (
                      <Button type="button" variant="ghost" className="mt-2" onClick={() => setAttentionExpanded(true)}>
                        and {hiddenProblemCount} more
                      </Button>
                    )}
                  </>
                )}
              </section>
            </>
          )}

          {activeTab === 'finance' && (
            <>
              {hasNoRatesAtAll && (
                <NotificationBanner tone="warning" className="mb-4">
                  No Unit Prices are set on this contract yet — every money figure below is empty because no rate has been entered, not because there's no work.
                </NotificationBanner>
              )}

              {/* Band 3 — money, for the CFO. */}
              <section className="mb-8">
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Money</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {contract.viewRates ? (
                    currentContractMonth ? (
                      <>
                        <StatCard
                          label="Value of Work this month"
                          value={money(valueThisMonth)}
                          sub={
                            <>
                              <DirectionBadge direction={monthDirection(valueThisMonth, valueLastMonth)} /> {money(valueLastMonth)} last month
                            </>
                          }
                        />
                        <StatCard
                          label="Margin this month"
                          value={<span className={`text-3xl ${marginThisMonth < 0 ? 'text-nc-danger-text' : ''}`}>{money(marginThisMonth)}</span>}
                          sub={
                            <>
                              <DirectionBadge direction={monthDirection(marginThisMonth, marginLastMonth)} /> {money(marginLastMonth)} last month
                            </>
                          }
                        />
                      </>
                    ) : (
                      <>
                        <StatCard label="Value of Work this month" value="—" sub={`No records yet for ${formatMonthLabel(nowMonthKey)}`} />
                        <StatCard label="Margin this month" value="—" sub={`No records yet for ${formatMonthLabel(nowMonthKey)}`} />
                      </>
                    )
                  ) : (
                    <>
                      <StatCard label="Value of Work this month" value="—" sub="Needs view_rates" />
                      <StatCard label="Margin this month" value="—" sub="Needs view_rates" />
                    </>
                  )}
                </div>
              </section>

              {/* Band 4 — month detail table. Not reachable single-column, so
                  hidden entirely below sm: rather than squeezed. */}
              <section className="hidden sm:block">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Month detail</h2>
              <div className="flex items-center gap-3">
                <div className="flex gap-2" role="group" aria-label="Column set">
                  <Button type="button" variant={monthView === 'period' ? 'primary' : 'secondary'} onClick={() => setMonthView('period')}>
                    This month
                  </Button>
                  <Button type="button" variant={monthView === 'to-date' ? 'primary' : 'secondary'} onClick={() => setMonthView('to-date')}>
                    To date
                  </Button>
                </div>
                <Select
                  className="w-auto"
                  value={selectedPeriod}
                  onChange={(e) => {
                    const [y, m] = e.target.value.split('-').map(Number)
                    setSelectedMonth({ year: y, month: m })
                  }}
                  aria-label="Month"
                >
                  {availableMonths.map((period) => {
                    const [y, m] = period.split('-').map(Number)
                    return (
                      <option key={period} value={period}>
                        {formatMonthLabel({ year: y, month: m })}
                      </option>
                    )
                  })}
                </Select>
              </div>
            </div>

            <Table>
              <THead>
                <TR>
                  <TH>Item #</TH>
                  <TH>Description</TH>
                  {monthView === 'period' ? (
                    <>
                      <TH align="right">Quantity this month</TH>
                      {contract.viewRates && (
                        <>
                          <TH align="right">Value this month</TH>
                          <TH align="right">Cost this month</TH>
                          <TH align="right">Margin this month</TH>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <TH align="right">Quantity to date</TH>
                      <TH align="right">Approximate Quantity</TH>
                      <TH align="right">Remaining</TH>
                      <TH align="right">% complete</TH>
                    </>
                  )}
                </TR>
              </THead>
              <TBody>
                {monthRows.map((r) => (
                  <TR key={r.item.id}>
                    <TD className="nc-numeric">{r.item.itemNumber}</TD>
                    {/* Fixed width, not left to the table's auto-layout: unconstrained, this
                        column measured 506px wide in the period column set vs 352px in the
                        to-date set for the exact same text — auto-layout balances its width
                        against whichever numeric columns happen to be visible, so it silently
                        pushed the period set to 1321px of real content inside a 1154px
                        container (measured, not estimated) at 1440px. `title` is mouse-hover-only
                        and shows nothing on a touch screen — fine here since this table is
                        desktop-only, but don't copy the pattern onto a touch-reachable screen
                        without a tap-to-reveal alternative. */}
                    <TD prose>
                      {/* The truncate/max-width lives on this inner div, not
                          the TD itself — a <td>'s own max-width is not
                          reliably respected by an auto-layout table (this
                          table isn't table-layout: fixed), but a fixed-width
                          block INSIDE it is, since the browser only needs to
                          make room for that block's width, not the text's
                          natural content width. */}
                      <div className="max-w-[280px] truncate" title={r.item.description}>
                        {r.item.description}
                      </div>
                    </TD>
                    {monthView === 'period' ? (
                      <>
                        <TD align="right" className="nc-numeric">
                          {fmtQuantity(r.quantityInPeriod, r.item.unit)}
                        </TD>
                        {contract.viewRates && (
                          <>
                            <TD align="right" className="nc-numeric">
                              {money(r.valueInPeriod)}
                            </TD>
                            <TD align="right" className="nc-numeric">
                              {money(r.costInPeriod)}
                            </TD>
                            <TD align="right" className={`nc-numeric ${r.marginInPeriod !== null && r.marginInPeriod < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
                              {r.marginInPeriod === null ? '—' : money(r.marginInPeriod)}
                            </TD>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <TD align="right" className="nc-numeric">
                          {fmtQuantity(r.quantityToDate)}
                        </TD>
                        <TD align="right" className="nc-numeric">
                          {r.approximateQuantity === null ? '—' : fmtQuantity(r.approximateQuantity)}
                        </TD>
                        {/* A negative Remaining reads as a deficit (recorded
                            past the Approximate Quantity), not a stray minus
                            sign — the over tone on both cells is the same
                            signal used everywhere else over-quantity shows up
                            (StatusBadge, the problem list above). */}
                        <TD align="right" className={`nc-numeric ${r.isOverQuantity ? 'bg-nc-over-bg font-semibold text-nc-over-text' : ''}`}>
                          {r.remaining === null ? '—' : fmtQuantity(r.remaining)}
                        </TD>
                        <TD align="right" className={`nc-numeric ${r.isOverQuantity ? 'bg-nc-over-bg font-semibold text-nc-over-text' : ''}`}>
                          {percent(r.proportionComplete)}
                        </TD>
                      </>
                    )}
                  </TR>
                ))}
              </TBody>
              {monthView === 'period' && contract.viewRates && (
                <tfoot>
                  <tr>
                    <td colSpan={2} className="text-data border-t border-nc-border bg-nc-secondary px-4 py-3 text-xs text-nc-text-muted">
                      {/* Width-capped for the same reason as the Description column above: an
                          unconstrained colSpan cell's content width feeds into the auto-layout
                          algorithm for BOTH columns it spans — this exact sentence, unwrapped,
                          was the actual source of Description's 506px width, not the row
                          descriptions themselves (already capped and had no effect alone). */}
                      <div className="max-w-[420px]">Contract totals for {formatMonthLabel(selectedMonth)} — quantity columns aren't summed (mixed units across items); the $ columns are.</div>
                    </td>
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right" />
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold text-nc-text">{money(monthTotals.value)}</td>
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold text-nc-text">{money(monthTotals.cost)}</td>
                    <td
                      className={`text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold ${monthTotals.margin !== null && monthTotals.margin < 0 ? 'text-nc-danger-text' : 'text-nc-text'}`}
                    >
                      {money(monthTotals.margin)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </Table>
              </section>
            </>
          )}
        </>
      )}
    </div>
  )
}
