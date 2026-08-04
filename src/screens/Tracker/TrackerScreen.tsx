import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { IconChevronDown, IconChevronRight, IconTable } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, type ItemPrice } from '../../lib/supabase/prices'
import { fetchItemMonths, fetchItemProgress, type ItemMonth, type ItemProgress } from '../../lib/supabase/monthlyPeriods'
import { fetchContractQuantityRecords } from '../../lib/supabase/quantityRecords'
import { fetchProgressEstimateReconciliation, type ProgressEstimateReconciliation } from '../../lib/supabase/progressEstimates'
import { filterEffective } from '../../lib/calculations/effectiveEntries'
import { compareItemCodes, sectionLabel, sectionPrefix } from '../../lib/calculations/naturalSort'
import { formatMonthLabel } from '../../lib/calculations/overview'
import { formatDayLabel } from '../../lib/dateFormat'
import { errorMessage } from '../../lib/errorMessage'
import { exportTrackerWorkbook } from '../../lib/export/trackerExport'
import { money, percent, quantity as fmtQuantity } from '../../lib/format'
import { Button, EmptyState, NotificationBanner, PageHeader, SandboxBanner, Spinner, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

function periodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number)
  return formatMonthLabel({ year: y, month: m })
}

const STICKY_WIDTHS = { itemNumber: 100, description: 220, unit: 90, approxQty: 130 }
const STICKY_LEFT = {
  itemNumber: 0,
  description: STICKY_WIDTHS.itemNumber,
  unit: STICKY_WIDTHS.itemNumber + STICKY_WIDTHS.description,
  approxQty: STICKY_WIDTHS.itemNumber + STICKY_WIDTHS.description + STICKY_WIDTHS.unit,
}

export function TrackerScreen() {
  const contract = useOutletContext<MyContract>()
  const navigate = useNavigate()

  const [items, setItems] = useState<Item[]>([])
  const [progress, setProgress] = useState<ItemProgress[]>([])
  const [prices, setPrices] = useState<ItemPrice[]>([])
  const [itemMonths, setItemMonths] = useState<ItemMonth[]>([])
  const [allRecords, setAllRecords] = useState<Awaited<ReturnType<typeof fetchContractQuantityRecords>>>([])
  const [reconciliation, setReconciliation] = useState<Map<string, ProgressEstimateReconciliation>>(new Map())
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expandedPeriods, setExpandedPeriods] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    setStatus('loading')
    Promise.all([
      fetchItems(contract.id),
      fetchItemProgress(contract.id),
      contract.viewRates ? fetchItemPrices(contract.id) : Promise.resolve([]),
      fetchItemMonths(contract.id),
      // SCALE LIMIT, noted not solved: pulls every quantity_records row on
      // the contract to derive day columns below. Fine at a demo contract's
      // few dozen rows; not fine at the several thousand a real contract
      // accumulates across a season. Needs a server-side daily/monthly
      // aggregate view before Hwy 5's second season — not building that now.
      fetchContractQuantityRecords(contract.id),
      contract.viewRates ? fetchProgressEstimateReconciliation(contract.id) : Promise.resolve(new Map<string, ProgressEstimateReconciliation>()),
    ])
      .then(([itemRows, progressRows, priceRows, itemMonthRows, recordRows, reconciliationMap]) => {
        setItems(itemRows)
        setProgress(progressRows)
        setPrices(priceRows)
        setItemMonths(itemMonthRows)
        setAllRecords(recordRows)
        setReconciliation(reconciliationMap)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err))
        setStatus('error')
      })
  }, [contract.id, contract.viewRates])

  const progressByItem = useMemo(() => new Map(progress.map((p) => [p.itemId, p])), [progress])
  const priceByItem = useMemo(() => new Map(prices.map((p) => [p.itemId, p])), [prices])

  // Current month is always included, even with zero itemMonth rows yet —
  // same reasoning as Overview's "no records yet" fix: an early-August
  // check with no August column at all reads as "nothing to see", while a
  // present-but-empty column (rendered "—", not "0", below) reads as "too
  // early to tell", which is the actually-true state.
  const currentPeriod = useMemo(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  }, [])
  const currentPeriodHasAnyData = useMemo(() => itemMonths.some((m) => m.periodMonth === currentPeriod), [itemMonths, currentPeriod])
  const periods = useMemo(() => {
    const set = new Set(itemMonths.map((m) => m.periodMonth))
    set.add(currentPeriod)
    return [...set].sort()
  }, [itemMonths, currentPeriod])

  const itemMonthByKey = useMemo(() => {
    const map = new Map<string, ItemMonth>()
    for (const m of itemMonths) map.set(`${m.itemId}|${m.periodMonth}`, m)
    return map
  }, [itemMonths])

  const effectiveRecords = useMemo(() => filterEffective(allRecords), [allRecords])

  const dayQuantityByKey = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of effectiveRecords) {
      const key = `${r.itemId}|${r.workDate}`
      map.set(key, (map.get(key) ?? 0) + r.quantity)
    }
    return map
  }, [effectiveRecords])

  const daysByPeriod = useMemo(() => {
    const sets = new Map<string, Set<string>>()
    for (const r of effectiveRecords) {
      const period = `${r.workDate.slice(0, 7)}-01`
      const set = sets.get(period) ?? new Set<string>()
      set.add(r.workDate)
      sets.set(period, set)
    }
    const sorted = new Map<string, string[]>()
    for (const [period, set] of sets) sorted.set(period, [...set].sort())
    return sorted
  }, [effectiveRecords])

  const sections = useMemo(() => {
    const byPrefix = new Map<string, Item[]>()
    for (const item of items) {
      const prefix = sectionPrefix(item.itemNumber)
      const list = byPrefix.get(prefix) ?? []
      list.push(item)
      byPrefix.set(prefix, list)
    }
    return [...byPrefix.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([prefix, sectionItems]) => ({
        prefix,
        label: sectionLabel(prefix),
        items: [...sectionItems].sort((a, b) => compareItemCodes(a.itemNumber, b.itemNumber)),
      }))
  }, [items])

  // Total column count, for the section-heading row's colSpan: 4 sticky +
  // one block per period (day columns, if that period is expanded, plus its
  // Quantity/Value total pair; otherwise just the Quantity/Value pair) + the
  // right block (Qty to Date, Remaining, % Complete always; Value to Date,
  // MoT Qty, MoT Total only with view_rates).
  const totalColumnCount = useMemo(() => {
    const periodColumns = periods.reduce((sum, period) => {
      const dayCount = expandedPeriods.has(period) ? (daysByPeriod.get(period)?.length ?? 0) : 0
      return sum + dayCount + 1 + (contract.viewRates ? 1 : 0)
    }, 0)
    return 4 + periodColumns + 3 + (contract.viewRates ? 3 : 0)
  }, [periods, expandedPeriods, daysByPeriod, contract.viewRates])

  function togglePeriod(period: string) {
    setExpandedPeriods((prev) => {
      const next = new Set(prev)
      if (next.has(period)) next.delete(period)
      else next.add(period)
      return next
    })
  }

  function goToDailyEntry(itemId: string, period: string) {
    navigate(`/daily-entry?itemId=${itemId}&period=${period}`)
  }

  async function handleExport() {
    setExporting(true)
    setExportError(null)
    try {
      await exportTrackerWorkbook(contract)
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
        title="Tracker"
        subtitle={contract.name}
        actions={
          contract.extractReport && (
            <Button type="button" variant="secondary" disabled={exporting} onClick={() => void handleExport()}>
              {exporting ? 'Exporting…' : 'Export to Excel'}
            </Button>
          )
        }
      />

      {exportError && (
        <NotificationBanner tone="danger" className="mb-4">
          {exportError}
        </NotificationBanner>
      )}

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

          {sections.length === 0 ? (
            <EmptyState icon={<IconTable size={32} stroke={1.5} />} title="No items to track yet." description="Add items on the Items screen first." />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH className="sticky left-0 z-10 bg-nc-secondary" style={{ width: STICKY_WIDTHS.itemNumber }}>
                    Item #
                  </TH>
                  <TH className="sticky z-10 bg-nc-secondary" style={{ left: STICKY_LEFT.description, width: STICKY_WIDTHS.description }}>
                    Description
                  </TH>
                  <TH className="sticky z-10 bg-nc-secondary" style={{ left: STICKY_LEFT.unit, width: STICKY_WIDTHS.unit }}>
                    Unit
                  </TH>
                  <TH align="right" className="sticky z-10 bg-nc-secondary" style={{ left: STICKY_LEFT.approxQty, width: STICKY_WIDTHS.approxQty }}>
                    Approx. Qty
                  </TH>
  
                  {periods.map((period) => {
                    const expanded = expandedPeriods.has(period)
                    const days = daysByPeriod.get(period) ?? []
                    return (
                      <Fragment key={period}>
                        {expanded &&
                          days.map((day) => (
                            <TH key={day} align="right">
                              {formatDayLabel(day)}
                            </TH>
                          ))}
                        <TH align="right">
                          <button type="button" className="flex items-center gap-1 hover:underline" onClick={() => togglePeriod(period)}>
                            {expanded ? <IconChevronDown size={14} stroke={2} /> : <IconChevronRight size={14} stroke={2} />}
                            {periodLabel(period)} Qty
                          </button>
                        </TH>
                        {contract.viewRates && <TH align="right">{periodLabel(period)} $</TH>}
                      </Fragment>
                    )
                  })}
  
                  <TH align="right">Qty to Date</TH>
                  {contract.viewRates && <TH align="right">Value to Date</TH>}
                  {contract.viewRates && <TH align="right">MoT Qty</TH>}
                  {contract.viewRates && <TH align="right">MoT Total</TH>}
                  <TH align="right">Remaining</TH>
                  <TH align="right">% Complete</TH>
                </TR>
              </THead>
              <TBody>
                {sections.map((section) => (
                  <Fragment key={section.prefix}>
                    <TR>
                      {/* Split into a small sticky label cell (spanning just the 4 sticky
                          columns, same width/left as they use) plus a plain filler cell for
                          the rest — a single `sticky` cell spanning the WHOLE row (colSpan
                          across everything) does not reliably stay pinned while scrolled;
                          this mirrors the mechanism already proven to work on the 4 real
                          sticky columns below instead of a new, larger one. */}
                      <TD
                        colSpan={4}
                        className="sticky left-0 z-10 bg-nc-secondary font-semibold text-nc-text"
                        style={{ width: STICKY_LEFT.approxQty + STICKY_WIDTHS.approxQty }}
                      >
                        {section.label}
                      </TD>
                      <TD colSpan={totalColumnCount - 4} className="bg-nc-secondary" />
                    </TR>
                    {section.items.map((item) => {
                      const unitPriced = item.itemKind === 'unit_price'
                      const itemProgress = progressByItem.get(item.id)
                      const price = priceByItem.get(item.id)
                      const unitPrice = unitPriced ? (price?.unitPrice ?? null) : null
                      const quantityToDate = unitPriced ? (itemProgress?.quantityToDate ?? 0) : null
                      const valueToDate = unitPriced && unitPrice !== null && quantityToDate !== null ? quantityToDate * unitPrice : null
                      const remaining = unitPriced ? item.approximateQuantity - (quantityToDate ?? 0) : null
                      const recon = reconciliation.get(item.itemNumber)
  
                      return (
                        <TR key={item.id}>
                          <TD className="nc-numeric sticky left-0 z-10 bg-white">{item.itemNumber}</TD>
                          <TD prose className="sticky z-10 bg-white" style={{ left: STICKY_LEFT.description }}>
                            <div className="max-w-[200px] truncate" title={item.description}>
                              {item.description}
                            </div>
                          </TD>
                          <TD className="sticky z-10 bg-white" style={{ left: STICKY_LEFT.unit }}>
                            {item.unit}
                          </TD>
                          <TD align="right" className="nc-numeric sticky z-10 bg-white" style={{ left: STICKY_LEFT.approxQty }}>
                            {unitPriced ? fmtQuantity(item.approximateQuantity) : '—'}
                          </TD>
  
                          {periods.map((period) => {
                            const expanded = expandedPeriods.has(period)
                            const days = daysByPeriod.get(period) ?? []
                            const inPeriod = itemMonthByKey.get(`${item.id}|${period}`)
                            // The current month with literally nothing recorded yet, contract-wide,
                            // renders "—" rather than "0" — 0.0 would read as "worked zero this
                            // month," when the true state is "too early in the month to tell,"
                            // same distinction Overview's money cards already make.
                            const isEmptyCurrentPeriod = period === currentPeriod && !currentPeriodHasAnyData
                            const quantityInPeriod = unitPriced ? (isEmptyCurrentPeriod ? null : (inPeriod?.quantityInPeriod ?? 0)) : null
                            const valueInPeriod = unitPriced && unitPrice !== null && quantityInPeriod !== null ? quantityInPeriod * unitPrice : null
  
                            return (
                              <Fragment key={period}>
                                {expanded &&
                                  days.map((day) => {
                                    const dayQty = unitPriced ? (dayQuantityByKey.get(`${item.id}|${day}`) ?? null) : null
                                    return (
                                      <TD key={day} align="right" className="nc-numeric">
                                        {dayQty === null ? (
                                          '—'
                                        ) : (
                                          <button type="button" className="hover:underline" onClick={() => goToDailyEntry(item.id, period)}>
                                            {fmtQuantity(dayQty)}
                                          </button>
                                        )}
                                      </TD>
                                    )
                                  })}
                                <TD align="right" className={`nc-numeric ${expanded ? 'font-semibold' : ''}`}>
                                  <button type="button" className="hover:underline" onClick={() => goToDailyEntry(item.id, period)}>
                                    {fmtQuantity(quantityInPeriod)}
                                  </button>
                                </TD>
                                {contract.viewRates && <TD align="right" className={`nc-numeric ${expanded ? 'font-semibold' : ''}`}>{money(valueInPeriod)}</TD>}
                              </Fragment>
                            )
                          })}
  
                          {/* Quantity to Date's place: a plain number for a Unit Price Item, but
                              Lump Sum and Provisional Sum have no quantity at all — % complete and
                              authorized-vs-provisional-sum respectively are the meaningful figures
                              for those two kinds, so they render here, labelled, instead of a bare
                              number that would read as a quantity. */}
                          <TD align="right" className="nc-numeric">
                            {item.itemKind === 'lump_sum'
                              ? `${percent(itemProgress?.percentComplete != null ? itemProgress.percentComplete / 100 : null)} complete`
                              : item.itemKind === 'provisional_sum'
                                ? `${money(itemProgress?.authorizedValue ?? null)} of ${money(itemProgress?.provisionalSum ?? null)}`
                                : fmtQuantity(quantityToDate)}
                          </TD>
                          {contract.viewRates && (
                            <TD align="right" className="nc-numeric">
                              {money(valueToDate)}
                            </TD>
                          )}
                          {contract.viewRates && (
                            <TD align="right" className="nc-numeric">
                              {recon?.certifiedQuantityToDate != null ? fmtQuantity(recon.certifiedQuantityToDate) : '—'}
                            </TD>
                          )}
                          {contract.viewRates && (
                            <TD align="right" className="nc-numeric">
                              {recon?.certifiedValueToDate != null ? money(recon.certifiedValueToDate) : '—'}
                            </TD>
                          )}
                          <TD align="right" className="nc-numeric">
                            {remaining === null ? '—' : fmtQuantity(remaining)}
                          </TD>
                          <TD align="right" className="nc-numeric">
                            {item.itemKind === 'provisional_sum' ? '—' : percent(itemProgress?.proportionComplete ?? null)}
                          </TD>
                        </TR>
                      )
                    })}
                  </Fragment>
                ))}
              </TBody>
            </Table>
          )}
        </>
      )}
    </div>
  )
}
