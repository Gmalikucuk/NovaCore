import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { IconAlertTriangle, IconArrowLeft, IconMinus, IconTrendingDown, IconTrendingUp } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, type ItemPrice } from '../../lib/supabase/prices'
import { fetchContractMonths, fetchItemMonths, fetchItemProgressRate, type ContractMonth, type ItemMonth, type ItemProgressRate } from '../../lib/supabase/monthlyPeriods'
import { fetchLastConfirmedAt } from '../../lib/supabase/quantityRecords'
import { formatMonthLabel, monthDirection, monthKeyFromDate, monthKeyToPeriod, previousMonth, type Direction, type MonthKey } from '../../lib/calculations/overview'
import { margin as computeMargin, sumOrNull } from '../../lib/calculations/margin'
import { formatConfirmedAt } from '../../lib/dateFormat'
import { errorMessage } from '../../lib/errorMessage'
import { exportFinanceWorkbook, type FinanceExportRow } from '../../lib/export/financeExport'
import { money, quantity as fmtQuantity } from '../../lib/format'
import { Button, NotificationBanner, PageHeader, SandboxBanner, Select, Spinner, StatCard, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

function DirectionBadge({ direction, sameIsGood }: { direction: Direction; sameIsGood?: boolean }) {
  if (direction === 'flat') return <IconMinus size={14} stroke={2} className="inline text-nc-text-muted" />
  const good = direction === 'up'
  const Icon = good ? IconTrendingUp : IconTrendingDown
  return <Icon size={14} stroke={2} className={`inline ${good || sameIsGood === false ? 'text-nc-success-text' : 'text-nc-danger-text'}`} />
}

/** A malformed or missing :period param (a hand-edited URL — every link this app generates itself is well-formed) falls back to the current month rather than an error page. */
function parsePeriodParam(period: string | undefined): MonthKey {
  if (period) {
    const [y, m] = period.split('-').map(Number)
    if (!Number.isNaN(y) && !Number.isNaN(m) && m >= 1 && m <= 12) return { year: y, month: m }
  }
  return monthKeyFromDate(new Date())
}

/**
 * One month's Item detail — this period, previous period, to date,
 * remaining, drill-down, export, the last-confirmed indicator. This is the
 * screen a row on the Finance month list opens to; the calculations and the
 * export were already correct when this lived inline on the Finance tab
 * (82f50bc), so this is a relocation, not a rewrite.
 */
export function FinanceMonthScreen() {
  const contract = useOutletContext<MyContract>()
  const navigate = useNavigate()
  const { period: periodParam } = useParams<{ period: string }>()

  const selectedMonth = useMemo(() => parsePeriodParam(periodParam), [periodParam])
  const selectedPeriod = monthKeyToPeriod(selectedMonth)
  const previousSelectedMonth = useMemo(() => previousMonth(selectedMonth), [selectedMonth])
  const previousSelectedPeriod = monthKeyToPeriod(previousSelectedMonth)
  const nowMonthKey = useMemo(() => monthKeyFromDate(new Date()), [])

  const [items, setItems] = useState<Item[]>([])
  const [prices, setPrices] = useState<ItemPrice[]>([])
  const [contractMonths, setContractMonths] = useState<ContractMonth[]>([])
  const [itemMonths, setItemMonths] = useState<ItemMonth[]>([])
  const [progressRate, setProgressRate] = useState<ItemProgressRate[]>([])
  const [lastConfirmedAt, setLastConfirmedAt] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    setStatus('loading')
    Promise.all([
      fetchItems(contract.id),
      contract.viewRates ? fetchItemPrices(contract.id) : Promise.resolve([]),
      contract.viewRates ? fetchContractMonths(contract.id) : Promise.resolve([]),
      fetchItemMonths(contract.id),
      fetchItemProgressRate(contract.id),
      fetchLastConfirmedAt(contract.id),
    ])
      .then(([itemRows, priceRows, contractMonthRows, itemMonthRows, progressRows, lastConfirmed]) => {
        setItems(itemRows)
        setPrices(priceRows)
        setContractMonths(contractMonthRows)
        setItemMonths(itemMonthRows)
        setProgressRate(progressRows)
        setLastConfirmedAt(lastConfirmed)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [contract.id, contract.viewRates])

  const priceByItem = useMemo(() => new Map(prices.map((p) => [p.itemId, p])), [prices])
  const progressByItem = useMemo(() => new Map(progressRate.map((p) => [p.itemId, p])), [progressRate])

  const currentContractMonth = contractMonths.find((m) => m.periodMonth === selectedPeriod)
  const previousContractMonth = contractMonths.find((m) => m.periodMonth === previousSelectedPeriod)
  const valueThisMonth = currentContractMonth?.valueInPeriod ?? 0
  const valueLastMonth = previousContractMonth?.valueInPeriod ?? 0
  const marginThisMonth = currentContractMonth?.marginInPeriod ?? 0
  const marginLastMonth = previousContractMonth?.marginInPeriod ?? 0

  const availableMonths = useMemo(() => {
    const keys = new Set(itemMonths.map((m) => m.periodMonth))
    keys.add(monthKeyToPeriod(nowMonthKey))
    return [...keys].sort().reverse()
  }, [itemMonths, nowMonthKey])

  const itemMonthByItem = useMemo(() => new Map(itemMonths.filter((m) => m.periodMonth === selectedPeriod).map((m) => [m.itemId, m])), [itemMonths, selectedPeriod])
  const previousItemMonthByItem = useMemo(() => new Map(itemMonths.filter((m) => m.periodMonth === previousSelectedPeriod).map((m) => [m.itemId, m])), [itemMonths, previousSelectedPeriod])

  const monthRows = useMemo(
    () =>
      items.map((item) => {
        const inPeriod = itemMonthByItem.get(item.id)
        const inPreviousPeriod = previousItemMonthByItem.get(item.id)
        const price = priceByItem.get(item.id)
        const progress = progressByItem.get(item.id)
        const unitPriced = item.itemKind === 'unit_price'
        const quantityInPeriod = unitPriced ? (inPeriod?.quantityInPeriod ?? 0) : null
        const quantityInPreviousPeriod = unitPriced ? (inPreviousPeriod?.quantityInPeriod ?? 0) : null
        const cost = unitPriced ? (price?.costPrice ?? null) : null
        const unitPrice = unitPriced ? (price?.unitPrice ?? null) : null
        const quantityToDate = unitPriced ? (progress?.quantityToDate ?? 0) : null
        return {
          item,
          quantityInPeriod,
          valueInPeriod: unitPrice !== null && quantityInPeriod !== null ? quantityInPeriod * unitPrice : null,
          costInPeriod: cost !== null && quantityInPeriod !== null ? quantityInPeriod * cost : null,
          marginInPeriod: unitPriced ? computeMargin(quantityInPeriod ?? 0, cost, unitPrice) : null,
          previousValueInPeriod: unitPrice !== null && quantityInPreviousPeriod !== null ? quantityInPreviousPeriod * unitPrice : null,
          previousMarginInPeriod: unitPriced ? computeMargin(quantityInPreviousPeriod ?? 0, cost, unitPrice) : null,
          quantityToDate,
          valueToDate: unitPrice !== null && quantityToDate !== null ? quantityToDate * unitPrice : null,
          costToDate: cost !== null && quantityToDate !== null ? quantityToDate * cost : null,
          marginToDate: unitPriced ? computeMargin(quantityToDate ?? 0, cost, unitPrice) : null,
          approximateQuantity: unitPriced ? item.approximateQuantity : null,
          remaining: unitPriced ? item.approximateQuantity - (quantityToDate ?? 0) : null,
          isOverQuantity: unitPriced ? (progress?.isOverQuantity ?? false) : false,
        }
      }),
    [items, itemMonthByItem, previousItemMonthByItem, priceByItem, progressByItem],
  )

  const monthTotals = useMemo(
    () => ({
      value: sumOrNull(monthRows.map((r) => r.valueInPeriod)),
      cost: sumOrNull(monthRows.map((r) => r.costInPeriod)),
      margin: sumOrNull(monthRows.map((r) => r.marginInPeriod)),
      previousValue: sumOrNull(monthRows.map((r) => r.previousValueInPeriod)),
      previousMargin: sumOrNull(monthRows.map((r) => r.previousMarginInPeriod)),
      toDateValue: sumOrNull(monthRows.map((r) => r.valueToDate)),
      toDateCost: sumOrNull(monthRows.map((r) => r.costToDate)),
      toDateMargin: sumOrNull(monthRows.map((r) => r.marginToDate)),
    }),
    [monthRows],
  )

  async function handleFinanceExport() {
    setExporting(true)
    setExportError(null)
    try {
      const unitPriceRows: FinanceExportRow[] = monthRows
        .filter((r): r is typeof r & { quantityToDate: number; approximateQuantity: number; remaining: number } => r.item.itemKind === 'unit_price')
        .map((r) => ({
          itemId: r.item.id,
          itemNumber: r.item.itemNumber,
          description: r.item.description,
          unit: r.item.unit,
          quantityInPeriod: r.quantityInPeriod,
          valueInPeriod: r.valueInPeriod,
          costInPeriod: r.costInPeriod,
          marginInPeriod: r.marginInPeriod,
          previousValueInPeriod: r.previousValueInPeriod,
          previousMarginInPeriod: r.previousMarginInPeriod,
          quantityToDate: r.quantityToDate,
          valueToDate: r.valueToDate,
          costToDate: r.costToDate,
          marginToDate: r.marginToDate,
          approximateQuantity: r.approximateQuantity,
          remaining: r.remaining,
          isOverQuantity: r.isOverQuantity,
        }))
      await exportFinanceWorkbook({
        contract,
        periodLabel: formatMonthLabel(selectedMonth),
        previousPeriodLabel: formatMonthLabel(previousSelectedMonth),
        lastConfirmedAt,
        selectedPeriod,
        rows: unitPriceRows,
        totals: monthTotals,
        appOrigin: window.location.origin,
      })
    } catch (err) {
      setExportError(errorMessage(err))
    } finally {
      setExporting(false)
    }
  }

  const unitPriceItems = useMemo(() => items.filter((i) => i.itemKind === 'unit_price'), [items])
  const hasNoRatesAtAll = contract.viewRates && unitPriceItems.length > 0 && !unitPriceItems.some((i) => priceByItem.get(i.id)?.unitPrice != null)

  return (
    <div>
      <PageHeader
        title="Finance"
        subtitle={`${contract.name} · ${formatMonthLabel(selectedMonth)}`}
        actions={
          <Button type="button" variant="ghost" onClick={() => navigate('/overview?tab=finance')}>
            <IconArrowLeft size={16} stroke={2} className="mr-1 inline" />
            Back to Finance
          </Button>
        }
      />

      <SandboxBanner contract={contract} />

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

          {/* Money, for the finance manager. The freshness line is the
              answer to "as of when" — not a page-load timestamp, the actual
              moment the records behind these figures were confirmed. */}
          <section className="mb-6">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Money — {formatMonthLabel(selectedMonth)}</h2>
              <p className="text-xs text-nc-text-muted">{lastConfirmedAt ? <>Confirmed records as of {formatConfirmedAt(lastConfirmedAt)}</> : 'No confirmed records yet'}</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {contract.viewRates ? (
                currentContractMonth ? (
                  <>
                    <StatCard
                      label="Value of Work"
                      value={money(valueThisMonth)}
                      sub={
                        <>
                          <DirectionBadge direction={monthDirection(valueThisMonth, valueLastMonth)} /> {money(valueLastMonth)} the prior month
                        </>
                      }
                    />
                    <StatCard
                      label="Margin"
                      value={<span className={`text-3xl ${marginThisMonth < 0 ? 'text-nc-danger-text' : ''}`}>{money(marginThisMonth)}</span>}
                      sub={
                        <>
                          <DirectionBadge direction={monthDirection(marginThisMonth, marginLastMonth)} /> {money(marginLastMonth)} the prior month
                        </>
                      }
                    />
                  </>
                ) : (
                  <>
                    <StatCard label="Value of Work" value="—" sub={`No records yet for ${formatMonthLabel(selectedMonth)}`} />
                    <StatCard label="Margin" value="—" sub={`No records yet for ${formatMonthLabel(selectedMonth)}`} />
                  </>
                )
              ) : (
                <>
                  <StatCard label="Value of Work" value="—" sub="Needs view_rates" />
                  <StatCard label="Margin" value="—" sub="Needs view_rates" />
                </>
              )}
            </div>
          </section>

          {/* Item detail. The billing-industry vocabulary a finance manager
              already thinks in: this period, previous period, to date,
              remaining. No % complete, no weighting — Remaining is a plain
              Approximate Quantity minus quantity to date. Not reachable
              single-column, so hidden entirely below sm: rather than
              squeezed. */}
          <section className="hidden sm:block">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Item detail</h2>
              <div className="flex items-center gap-3">
                <Select
                  className="w-auto"
                  value={selectedPeriod}
                  onChange={(e) => navigate(`/finance/${e.target.value}`)}
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
                <Button type="button" variant="secondary" disabled={exporting} onClick={() => void handleFinanceExport()}>
                  {exporting ? 'Exporting…' : 'Export to Excel'}
                </Button>
              </div>
            </div>

            {exportError && (
              <NotificationBanner tone="danger" className="mb-3">
                {exportError}
              </NotificationBanner>
            )}

            <Table>
              <THead>
                <TR>
                  <TH>Item #</TH>
                  <TH>Description</TH>
                  <TH align="right">Qty — {formatMonthLabel(selectedMonth)}</TH>
                  {contract.viewRates && (
                    <>
                      <TH align="right">Value — {formatMonthLabel(selectedMonth)}</TH>
                      <TH align="right">Cost — {formatMonthLabel(selectedMonth)}</TH>
                      <TH align="right">Margin — {formatMonthLabel(selectedMonth)}</TH>
                      <TH align="right">Value — {formatMonthLabel(previousSelectedMonth)}</TH>
                      <TH align="right">Margin — {formatMonthLabel(previousSelectedMonth)}</TH>
                    </>
                  )}
                  <TH align="right">Qty to date</TH>
                  {contract.viewRates && (
                    <>
                      <TH align="right">Value to date</TH>
                      <TH align="right">Cost to date</TH>
                      <TH align="right">Margin to date</TH>
                    </>
                  )}
                  <TH align="right">Approx. Qty</TH>
                  <TH align="right">Remaining</TH>
                </TR>
              </THead>
              <TBody>
                {monthRows.map((r) => (
                  <TR key={r.item.id}>
                    {/* Item # is the drill-down: the same ?itemId=&period=
                        deep link the Tracker screen already uses to reach
                        Daily Entry, not a new drill-down framework — the
                        shortest honest path from a figure on this row to
                        the confirmed records behind it. */}
                    <TD className="nc-numeric">
                      <button
                        type="button"
                        className="text-nc-info-text underline decoration-dotted hover:decoration-solid"
                        onClick={() => navigate(`/daily-entry?itemId=${r.item.id}&period=${selectedPeriod}`)}
                        title={`View ${formatMonthLabel(selectedMonth)}'s confirmed records for ${r.item.itemNumber}`}
                      >
                        {r.item.itemNumber}
                      </button>
                    </TD>
                    {/* Fixed width, not left to the table's auto-layout: unconstrained, this
                        column measured 506px wide in an earlier column set for the exact same
                        text — auto-layout balances its width against whichever numeric columns
                        happen to be visible. `title` is mouse-hover-only and shows nothing on a
                        touch screen — fine here since this table is desktop-only, but don't copy
                        the pattern onto a touch-reachable screen without a tap-to-reveal alternative. */}
                    <TD prose>
                      {/* The truncate/max-width lives on this inner div, not
                          the TD itself — a <td>'s own max-width is not
                          reliably respected by an auto-layout table (this
                          table isn't table-layout: fixed), but a fixed-width
                          block INSIDE it is, since the browser only needs to
                          make room for that block's width, not the text's
                          natural content width. */}
                      <div className="max-w-[220px] truncate" title={r.item.description}>
                        {r.item.description}
                      </div>
                    </TD>
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
                        <TD align="right" className="nc-numeric">
                          {money(r.previousValueInPeriod)}
                        </TD>
                        <TD align="right" className={`nc-numeric ${r.previousMarginInPeriod !== null && r.previousMarginInPeriod < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
                          {r.previousMarginInPeriod === null ? '—' : money(r.previousMarginInPeriod)}
                        </TD>
                      </>
                    )}
                    <TD align="right" className="nc-numeric">
                      <button
                        type="button"
                        className="text-nc-info-text underline decoration-dotted hover:decoration-solid"
                        onClick={() => navigate(`/daily-entry?itemId=${r.item.id}`)}
                        title={`View ${r.item.itemNumber}'s confirmed records`}
                      >
                        {fmtQuantity(r.quantityToDate)}
                      </button>
                    </TD>
                    {contract.viewRates && (
                      <>
                        <TD align="right" className="nc-numeric">
                          {money(r.valueToDate)}
                        </TD>
                        <TD align="right" className="nc-numeric">
                          {money(r.costToDate)}
                        </TD>
                        <TD align="right" className={`nc-numeric ${r.marginToDate !== null && r.marginToDate < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
                          {r.marginToDate === null ? '—' : money(r.marginToDate)}
                        </TD>
                      </>
                    )}
                    <TD align="right" className="nc-numeric">
                      {r.approximateQuantity === null ? '—' : fmtQuantity(r.approximateQuantity)}
                    </TD>
                    {/* Over quantity: the existing violet "over" tone, but
                        colour is never the only signal — an icon plus "…
                        over" reads correctly even in greyscale, same
                        phrasing OwnerScreen already uses for the same
                        condition. */}
                    <TD align="right" className={`nc-numeric ${r.isOverQuantity ? 'bg-nc-over-bg font-semibold text-nc-over-text' : ''}`}>
                      {r.remaining === null ? (
                        '—'
                      ) : r.isOverQuantity ? (
                        <span className="inline-flex items-center justify-end gap-1">
                          <IconAlertTriangle size={13} stroke={1.75} />
                          {fmtQuantity(Math.abs(r.remaining))} over
                        </span>
                      ) : (
                        fmtQuantity(r.remaining)
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
              {contract.viewRates && (
                <tfoot>
                  <tr>
                    <td colSpan={2} className="text-data border-t border-nc-border bg-nc-secondary px-4 py-3 text-xs text-nc-text-muted">
                      {/* Width-capped for the same reason as the Description column above: an
                          unconstrained colSpan cell's content width feeds into the auto-layout
                          algorithm for BOTH columns it spans. */}
                      <div className="max-w-[200px]">Totals — quantity columns aren't summed (mixed units across Items); the $ columns are.</div>
                    </td>
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right" />
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold text-nc-text">{money(monthTotals.value)}</td>
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold text-nc-text">{money(monthTotals.cost)}</td>
                    <td
                      className={`text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold ${monthTotals.margin !== null && monthTotals.margin < 0 ? 'text-nc-danger-text' : 'text-nc-text'}`}
                    >
                      {money(monthTotals.margin)}
                    </td>
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold text-nc-text">{money(monthTotals.previousValue)}</td>
                    <td
                      className={`text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold ${monthTotals.previousMargin !== null && monthTotals.previousMargin < 0 ? 'text-nc-danger-text' : 'text-nc-text'}`}
                    >
                      {money(monthTotals.previousMargin)}
                    </td>
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right" />
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold text-nc-text">{money(monthTotals.toDateValue)}</td>
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold text-nc-text">{money(monthTotals.toDateCost)}</td>
                    <td
                      className={`text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right font-semibold ${monthTotals.toDateMargin !== null && monthTotals.toDateMargin < 0 ? 'text-nc-danger-text' : 'text-nc-text'}`}
                    >
                      {money(monthTotals.toDateMargin)}
                    </td>
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right" />
                    <td className="text-data nc-numeric border-t border-nc-border bg-nc-secondary px-4 py-3 text-right" />
                  </tr>
                </tfoot>
              )}
            </Table>
          </section>
        </>
      )}
    </div>
  )
}
