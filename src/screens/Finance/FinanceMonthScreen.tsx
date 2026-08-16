import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { IconArrowLeft, IconMinus, IconTrendingDown, IconTrendingUp } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, type ItemPrice } from '../../lib/supabase/prices'
import { fetchContractMonths, fetchItemMonths, fetchItemProgressRate, type ContractMonth, type ItemMonth, type ItemProgressRate } from '../../lib/supabase/monthlyPeriods'
import { fetchLastConfirmedAt } from '../../lib/supabase/quantityRecords'
import { formatMonthLabel, monthDirection, monthKeyFromDate, monthKeyToPeriod, previousMonth, type Direction, type MonthKey } from '../../lib/calculations/overview'
import { costTrackingVisible, estimatedCost, gateOnCostTracking, margin as computeMargin, sumOrNull } from '../../lib/calculations/margin'
import { resolveFinanceMonthColumns, type FinanceMonthColumnVisibility } from '../../lib/calculations/financeMonthColumns'
import { fetchViewPreferences, saveViewPreferences } from '../../lib/supabase/viewPreferences'
import { formatConfirmedAt } from '../../lib/dateFormat'
import { errorMessage } from '../../lib/errorMessage'
import { exportFinanceWorkbook, type FinanceExportRow } from '../../lib/export/financeExport'
import { rate, quantity as fmtQuantity } from '../../lib/format'
import { Button, EmptyState, NotificationBanner, PageHeader, SandboxBanner, Select, Spinner, StatCard, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

function DirectionBadge({ direction, sameIsGood }: { direction: Direction; sameIsGood?: boolean }) {
  if (direction === 'flat') return <IconMinus size={14} stroke={2} className="inline text-nc-text-muted" />
  const good = direction === 'up'
  const Icon = good ? IconTrendingUp : IconTrendingDown
  return <Icon size={14} stroke={2} className={`inline ${good || sameIsGood === false ? 'text-nc-success-text' : 'text-nc-danger-text'}`} />
}

/** Same convention as Rates' subtotal/grand-total rows: silent when a total is complete, stated in plain language only when it's genuinely partial. */
function CoverageNote({ coverage }: { coverage: { count: number; total: number } }) {
  if (coverage.total === 0 || coverage.count === coverage.total) return null
  return (
    <span className="mt-1 block text-xs font-normal text-nc-text-muted">
      Covers {coverage.count} of {coverage.total} priced Items.
    </span>
  )
}

/** A malformed or missing :period param (a hand-edited URL — every link this app generates itself is well-formed) falls back to the current month rather than an error page. */
function parsePeriodParam(period: string | undefined): MonthKey {
  if (period) {
    const [y, m] = period.split('-').map(Number)
    if (!Number.isNaN(y) && !Number.isNaN(m) && m >= 1 && m <= 12) return { year: y, month: m }
  }
  return monthKeyFromDate(new Date())
}

const PREFS_SCOPE = 'finance_month_detail'
type MonthLineFilter = 'all' | 'this_period' | 'not_started'
const FILTER_LABEL: Record<MonthLineFilter, string> = { all: 'All items', this_period: 'This period', not_started: 'Not started' }
function sanitizeFilter(raw: unknown): MonthLineFilter {
  return raw === 'this_period' || raw === 'not_started' ? raw : 'all'
}

type ColumnKey = keyof FinanceMonthColumnVisibility
const COLUMN_LABEL: Record<ColumnKey, string> = {
  quantityInPeriod: 'Quantity this period',
  valueToDate: 'Value to date',
  quantityToDate: 'Quantity to date',
  costInPeriod: 'Est. cost this period',
  marginInPeriod: 'Est. margin this period',
  costToDate: 'Est. cost to date',
  marginToDate: 'Est. margin to date',
}

function ColumnsControl({ columns, costVisible, onToggle }: { columns: FinanceMonthColumnVisibility; costVisible: boolean; onToggle: (key: ColumnKey) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  const keys: ColumnKey[] = costVisible
    ? ['quantityInPeriod', 'valueToDate', 'quantityToDate', 'costInPeriod', 'marginInPeriod', 'costToDate', 'marginToDate']
    : ['quantityInPeriod', 'valueToDate', 'quantityToDate']

  return (
    <div className="relative" ref={ref}>
      <Button type="button" variant="secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="true">
        Columns
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-nc-border bg-white p-2 shadow-lg">
          <p className="px-2 pb-1.5 pt-1 text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Columns</p>
          {keys.map((key) => (
            <label key={key} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-nc-text hover:bg-nc-secondary">
              <input type="checkbox" checked={columns[key]} onChange={() => onToggle(key)} className="h-4 w-4 rounded border-nc-border" />
              {COLUMN_LABEL[key]}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Item # and Description merged into one identity line — description is
 * what gets read, the item number beneath it is the drill-down (the same
 * ?itemId=&period= deep link Tracker already uses to reach Daily Entry),
 * kept as a link rather than folded into plain text since it's still an
 * affordance, not just a label. max-w constrains the truncating div's own
 * content width rather than the TD's, so an unusually long description
 * can't feed back into the table's column-width math the way an
 * unconstrained cell would.
 */
function ItemIdentity({ item, onOpenPeriod, periodLabel }: { item: Item; onOpenPeriod: () => void; periodLabel: string }) {
  return (
    <div>
      <div className="max-w-[260px] truncate text-sm text-nc-text" title={item.description}>
        {item.description}
      </div>
      <div className="mt-0.5 text-xs">
        <button
          type="button"
          className="text-nc-info-text underline decoration-dotted hover:decoration-solid"
          onClick={onOpenPeriod}
          title={`View ${periodLabel}'s confirmed records for ${item.itemNumber}`}
        >
          {item.itemNumber}
        </button>
      </div>
    </div>
  )
}

/**
 * One month's Item detail — this period, to date, drill-down, export, the
 * last-confirmed indicator. This is the screen a row on the Finance month
 * list opens to; the calculations and the export were already correct
 * when this lived inline on the Finance tab (82f50bc), so this remains a
 * relocation at heart — this pass brings its own layout up to the pattern
 * Rates and the progress claim screen already established: one identity
 * column, the unit living once beside its own quantity, a small proposed
 * default column set with the rest behind a Columns control, filters for
 * an otherwise-em-dash row, and totals as cards below the table rather
 * than a footnoted footer row.
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
  const selectedMonthLabel = formatMonthLabel(selectedMonth)

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

  const costVisible = costTrackingVisible(contract)

  // Columns and filter, both persisted per seat under one scope (same
  // delta-merge pattern Rates uses for its own column preferences) —
  // resolved fresh against costVisible on every load and every rights
  // change, never trusted from a stale saved blob.
  const [columns, setColumns] = useState<FinanceMonthColumnVisibility>(resolveFinanceMonthColumns(null, costVisible))
  const [filter, setFilter] = useState<MonthLineFilter>('all')
  const prefsLoaded = useRef(false)
  const rawPrefs = useRef<Record<string, unknown> | null>(null)
  const lastPersisted = useRef<string>('{}')

  useEffect(() => {
    fetchViewPreferences(PREFS_SCOPE)
      .then((raw) => {
        rawPrefs.current = raw
        lastPersisted.current = JSON.stringify(raw ?? {})
        setColumns(resolveFinanceMonthColumns(raw, costVisible))
        setFilter(sanitizeFilter(raw?.lineFilter))
      })
      .catch(() => {
        rawPrefs.current = null
        setColumns(resolveFinanceMonthColumns(null, costVisible))
      })
      .finally(() => {
        prefsLoaded.current = true
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract.id])

  useEffect(() => {
    if (!prefsLoaded.current) return
    setColumns(resolveFinanceMonthColumns(rawPrefs.current, costVisible))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [costVisible])

  function persist(nextRaw: Record<string, unknown>) {
    rawPrefs.current = nextRaw
    const serialized = JSON.stringify(nextRaw)
    if (prefsLoaded.current && serialized !== lastPersisted.current) {
      void saveViewPreferences(PREFS_SCOPE, nextRaw).then(() => {
        lastPersisted.current = serialized
      })
    }
  }

  function toggleColumn(key: ColumnKey) {
    const nextRaw = { ...(rawPrefs.current ?? {}), [key]: !columns[key] }
    setColumns(resolveFinanceMonthColumns(nextRaw, costVisible))
    persist(nextRaw)
  }

  function changeFilter(next: MonthLineFilter) {
    setFilter(next)
    persist({ ...(rawPrefs.current ?? {}), lineFilter: next })
  }

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
  // A month CAN have real recorded value while its cost/margin stays null —
  // cost coverage incomplete that month, not zero margin. `?? 0` here would
  // repeat the exact absent/zero conflation this screen exists to fix, one
  // level up from the per-item table.
  const valueThisMonth = currentContractMonth?.valueInPeriod ?? null
  const valueLastMonth = previousContractMonth?.valueInPeriod ?? null
  const marginThisMonth = gateOnCostTracking(currentContractMonth?.marginInPeriod ?? null, costVisible)
  const marginLastMonth = gateOnCostTracking(previousContractMonth?.marginInPeriod ?? null, costVisible)

  const availableMonths = useMemo(() => {
    const keys = new Set(itemMonths.map((m) => m.periodMonth))
    keys.add(monthKeyToPeriod(nowMonthKey))
    return [...keys].sort().reverse()
  }, [itemMonths, nowMonthKey])

  const itemMonthByItem = useMemo(() => new Map(itemMonths.filter((m) => m.periodMonth === selectedPeriod).map((m) => [m.itemId, m])), [itemMonths, selectedPeriod])
  // Previous-period figures aren't shown in the table anymore (the top
  // Money band already compares this month to last, at the contract
  // level) — kept per-row purely because the Excel export still has its
  // own "previous period" columns, unaffected by what the on-screen table
  // decides to show.
  const previousItemMonthByItem = useMemo(() => new Map(itemMonths.filter((m) => m.periodMonth === previousSelectedPeriod).map((m) => [m.itemId, m])), [itemMonths, previousSelectedPeriod])

  const monthRows = useMemo(
    () =>
      items.map((item) => {
        const inPeriod = itemMonthByItem.get(item.id)
        const inPreviousPeriod = previousItemMonthByItem.get(item.id)
        const price = priceByItem.get(item.id)
        const progress = progressByItem.get(item.id)
        const unitPriced = item.itemKind === 'unit_price'
        // No itemMonth row for this Item this period means literally no
        // records were confirmed then — absent, not a zero quantity. `?? 0`
        // here would silently turn "nothing happened" into a real placed
        // amount of zero, which is exactly the em-dash/$0.00 conflation
        // this screen exists to fix.
        const quantityInPeriod = unitPriced ? (inPeriod ? inPeriod.quantityInPeriod : null) : null
        const quantityInPreviousPeriod = unitPriced ? (inPreviousPeriod ? inPreviousPeriod.quantityInPeriod : null) : null
        // Cost/margin/period-cost/period-margin/cost-to-date/margin-to-date
        // all derive from this one variable — nulled here, at the source,
        // when cost tracking is off for this contract (0042), rather than
        // at each of the derived figures below.
        const cost = unitPriced ? gateOnCostTracking(price?.costPrice ?? null, costTrackingVisible({ costTrackingEnabled: contract.costTrackingEnabled, setCost: contract.setCost })) : null
        const costBasis = unitPriced ? (price?.costBasis ?? null) : null
        const unitPrice = unitPriced ? (price?.unitPrice ?? null) : null
        const quantityToDate = unitPriced ? (progress?.quantityToDate ?? 0) : null
        // A total is a flat figure about the whole Item's life, not this
        // month's share of it — there's no honest way to allocate a lump
        // subcontract quote into a calendar month without prorating against
        // the Approximate Quantity, which is exactly the derivation this
        // shape exists to stop treating as a fact (0023). Period cost/margin
        // are therefore only ever computed for a per_unit basis; a total
        // basis reads as absent here, same as v_contract_month's own
        // narrowing — present but incomplete for that Item's period rows,
        // never a prorated guess. costToDate/marginToDate face no such
        // problem: a total doesn't scale with quantity, so it's usable
        // as-is regardless of how much time has passed.
        const periodCost = costBasis === 'per_unit' ? cost : null
        return {
          item,
          quantityInPeriod,
          valueInPeriod: unitPrice !== null && quantityInPeriod !== null ? quantityInPeriod * unitPrice : null,
          costInPeriod: periodCost !== null && quantityInPeriod !== null ? quantityInPeriod * periodCost : null,
          marginInPeriod: unitPriced && costBasis === 'per_unit' && quantityInPeriod !== null ? computeMargin(quantityInPeriod, cost, unitPrice, costBasis) : null,
          previousValueInPeriod: unitPrice !== null && quantityInPreviousPeriod !== null ? quantityInPreviousPeriod * unitPrice : null,
          previousMarginInPeriod:
            unitPriced && costBasis === 'per_unit' && quantityInPreviousPeriod !== null ? computeMargin(quantityInPreviousPeriod, cost, unitPrice, costBasis) : null,
          quantityToDate,
          valueToDate: unitPrice !== null && quantityToDate !== null ? quantityToDate * unitPrice : null,
          costToDate: unitPriced ? estimatedCost(quantityToDate ?? 0, cost, costBasis) : null,
          marginToDate: unitPriced ? computeMargin(quantityToDate ?? 0, cost, unitPrice, costBasis) : null,
          // Kept for the export (which still reports remaining/approximate
          // quantity), even though the table itself no longer shows either
          // — that pair belongs to Tracker now, which already shows them.
          approximateQuantity: unitPriced ? item.approximateQuantity : null,
          remaining: unitPriced ? item.approximateQuantity - (quantityToDate ?? 0) : null,
          isOverQuantity: unitPriced ? (progress?.isOverQuantity ?? false) : false,
        }
      }),
    [items, itemMonthByItem, previousItemMonthByItem, priceByItem, progressByItem, contract.costTrackingEnabled, contract.setCost],
  )

  // The filter that keeps an all-em-dash row from being the default read:
  // "this period" is exactly the rows a "what happened this month" reader
  // wants, "not started" surfaces unit_price Items nothing has ever been
  // recorded against. Totals below are computed from this filtered set,
  // not the full table — a total should describe what's actually on
  // screen, same as the progress claim screen's own filtered total.
  const filteredRows = useMemo(() => {
    if (filter === 'this_period') return monthRows.filter((r) => r.quantityInPeriod !== null)
    if (filter === 'not_started') return monthRows.filter((r) => r.item.itemKind === 'unit_price' && (r.quantityToDate ?? 0) === 0)
    return monthRows
  }, [monthRows, filter])

  const monthTotals = useMemo(
    () => ({
      value: sumOrNull(filteredRows.map((r) => r.valueInPeriod)),
      cost: sumOrNull(filteredRows.map((r) => r.costInPeriod)),
      margin: sumOrNull(filteredRows.map((r) => r.marginInPeriod)),
      toDateValue: sumOrNull(filteredRows.map((r) => r.valueToDate)),
      toDateCost: sumOrNull(filteredRows.map((r) => r.costToDate)),
      toDateMargin: sumOrNull(filteredRows.map((r) => r.marginToDate)),
    }),
    [filteredRows],
  )

  // Coverage — same convention as Rates: state it wherever a total is
  // genuinely partial, say nothing where it's complete. Scoped to the
  // filtered set, matching the totals they annotate.
  const filteredUnitPriceRows = useMemo(() => filteredRows.filter((r) => r.item.itemKind === 'unit_price'), [filteredRows])
  const valueCoverage = useMemo(
    () => ({ count: filteredUnitPriceRows.filter((r) => priceByItem.get(r.item.id)?.unitPrice != null).length, total: filteredUnitPriceRows.length }),
    [filteredUnitPriceRows, priceByItem],
  )
  const periodActiveRows = useMemo(() => filteredUnitPriceRows.filter((r) => r.quantityInPeriod !== null), [filteredUnitPriceRows])
  const periodCostCoverage = useMemo(() => ({ count: periodActiveRows.filter((r) => r.costInPeriod !== null).length, total: periodActiveRows.length }), [periodActiveRows])
  const periodMarginCoverage = useMemo(() => ({ count: periodActiveRows.filter((r) => r.marginInPeriod !== null).length, total: periodActiveRows.length }), [periodActiveRows])
  const toDateCostCoverage = useMemo(
    () => ({ count: filteredUnitPriceRows.filter((r) => r.costToDate !== null).length, total: filteredUnitPriceRows.length }),
    [filteredUnitPriceRows],
  )
  const toDateMarginCoverage = useMemo(
    () => ({ count: filteredUnitPriceRows.filter((r) => r.marginToDate !== null).length, total: filteredUnitPriceRows.length }),
    [filteredUnitPriceRows],
  )

  // The export always covers every Item regardless of the on-screen
  // filter — it's a standalone document someone opens later, not a
  // snapshot of what happened to be visible when it was generated.
  const exportTotals = useMemo(
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
        periodLabel: selectedMonthLabel,
        previousPeriodLabel: formatMonthLabel(previousSelectedMonth),
        lastConfirmedAt,
        selectedPeriod,
        rows: unitPriceRows,
        totals: exportTotals,
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

  // Design-target pixel widths — see Rates' own COL_W comment for why these
  // are ratios, not literal pixels: table-layout: fixed plus percentage
  // columns (pctW below) is what actually renders, scaling every column
  // down together the moment the screen's own width cap constrains it.
  const COL_W = { quantityInPeriod: 170, valueInPeriod: 130, costInPeriod: 130, marginInPeriod: 130, quantityToDate: 170, valueToDate: 130, costToDate: 130, marginToDate: 130 }
  const IDENTITY_MIN_W = 220
  const IDENTITY_MAX_W = 300
  const TABLE_TARGET_W = 1360
  const fixedColumnsW =
    COL_W.valueInPeriod +
    (columns.quantityInPeriod ? COL_W.quantityInPeriod : 0) +
    (columns.costInPeriod ? COL_W.costInPeriod : 0) +
    (columns.marginInPeriod ? COL_W.marginInPeriod : 0) +
    (columns.quantityToDate ? COL_W.quantityToDate : 0) +
    (columns.valueToDate ? COL_W.valueToDate : 0) +
    (columns.costToDate ? COL_W.costToDate : 0) +
    (columns.marginToDate ? COL_W.marginToDate : 0)
  const identityW = Math.min(IDENTITY_MAX_W, Math.max(IDENTITY_MIN_W, TABLE_TARGET_W - fixedColumnsW))
  const tableWidthPx = fixedColumnsW + identityW
  const pctW = (px: number) => `${Math.round((px / tableWidthPx) * 10000) / 100}%`

  return (
    // tableWidthPx caps the whole screen — title through totals cards —
    // same one-shared-measure rule Rates now follows, rather than the
    // table alone measuring differently from the banners and cards around
    // it.
    <div style={{ maxWidth: tableWidthPx, marginLeft: 'auto', marginRight: 'auto' }}>
      <PageHeader
        title="Finance"
        subtitle={`${contract.name} · ${selectedMonthLabel}`}
        actions={
          <Button type="button" variant="ghost" onClick={() => navigate('/finance')}>
            <IconArrowLeft size={16} stroke={2} className="mr-1 inline" />
            Back to Months
          </Button>
        }
      />

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

          {/* Money, for the finance manager. The freshness line is the
              answer to "as of when" — not a page-load timestamp, the actual
              moment the records behind these figures were confirmed. */}
          <section className="mb-6">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Money — {selectedMonthLabel}</h2>
              <p className="text-xs text-nc-text-muted">{lastConfirmedAt ? <>Confirmed records as of {formatConfirmedAt(lastConfirmedAt)}</> : 'No confirmed records yet'}</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {contract.viewRates ? (
                currentContractMonth ? (
                  <>
                    <StatCard
                      label="Value of Work"
                      value={rate(valueThisMonth)}
                      sub={
                        valueThisMonth !== null && valueLastMonth !== null ? (
                          <>
                            <DirectionBadge direction={monthDirection(valueThisMonth, valueLastMonth)} /> {rate(valueLastMonth)} the prior month
                          </>
                        ) : (
                          'No prior month to compare'
                        )
                      }
                    />
                    <StatCard
                      label="Est. margin"
                      value={marginThisMonth === null ? '—' : <span className={`text-3xl ${marginThisMonth < 0 ? 'text-nc-danger-text' : ''}`}>{rate(marginThisMonth)}</span>}
                      sub={
                        marginThisMonth === null ? (
                          contract.costTrackingEnabled ? (
                            "Cost isn't fully priced for this month's Items"
                          ) : undefined
                        ) : marginLastMonth !== null ? (
                          <>
                            <DirectionBadge direction={monthDirection(marginThisMonth, marginLastMonth)} /> {rate(marginLastMonth)} the prior month
                          </>
                        ) : (
                          'No prior month to compare'
                        )
                      }
                    />
                  </>
                ) : (
                  <>
                    <StatCard label="Value of Work" value="—" sub={`No records yet for ${selectedMonthLabel}`} />
                    <StatCard label="Est. margin" value="—" sub={`No records yet for ${selectedMonthLabel}`} />
                  </>
                )
              ) : (
                <>
                  <StatCard label="Value of Work" value="—" sub="Needs rate-viewing permission" />
                  <StatCard label="Est. margin" value="—" sub="Needs rate-viewing permission" />
                </>
              )}
            </div>
          </section>

          {/* Item detail. The billing-industry vocabulary a finance manager
              already thinks in: this period, to date. Not reachable
              single-column, so hidden entirely below sm: rather than
              squeezed. */}
          <section className="hidden sm:block">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Item detail</h2>
              <div className="flex items-center gap-3">
                <Select className="w-auto" value={selectedPeriod} onChange={(e) => navigate(`/finance/${e.target.value}`)} aria-label="Month">
                  {availableMonths.map((period) => {
                    const [y, m] = period.split('-').map(Number)
                    return (
                      <option key={period} value={period}>
                        {formatMonthLabel({ year: y, month: m })}
                      </option>
                    )
                  })}
                </Select>
                {contract.viewRates && <ColumnsControl columns={columns} costVisible={costVisible} onToggle={toggleColumn} />}
                <Button type="button" variant="secondary" disabled={exporting} onClick={() => void handleFinanceExport()}>
                  {exporting ? 'Exporting…' : 'Export to Excel'}
                </Button>
              </div>
            </div>

            <div className="mb-4 flex gap-2" role="group" aria-label="Item filter">
              {(['all', 'this_period', 'not_started'] as MonthLineFilter[]).map((f) => (
                <Button key={f} type="button" variant={filter === f ? 'primary' : 'secondary'} onClick={() => changeFilter(f)}>
                  {FILTER_LABEL[f]}
                </Button>
              ))}
            </div>

            {exportError && (
              <NotificationBanner tone="danger" className="mb-3">
                {exportError}
              </NotificationBanner>
            )}

            {filteredRows.length === 0 ? (
              <EmptyState title="No items match this filter." description="Try a different filter above." />
            ) : (
              <div style={{ width: '100%' }}>
                <Table style={{ tableLayout: 'fixed', width: '100%' }}>
                  <THead>
                    <TR>
                      <TH style={{ width: pctW(identityW) }}>Item</TH>
                      {columns.quantityInPeriod && (
                        <TH align="right" style={{ width: pctW(COL_W.quantityInPeriod) }}>
                          Qty — {selectedMonthLabel}
                        </TH>
                      )}
                      {contract.viewRates && (
                        <>
                          <TH align="right" style={{ width: pctW(COL_W.valueInPeriod) }}>
                            Value — {selectedMonthLabel}
                          </TH>
                          {columns.costInPeriod && (
                            <TH align="right" style={{ width: pctW(COL_W.costInPeriod) }}>
                              Est. cost — {selectedMonthLabel}
                            </TH>
                          )}
                          {columns.marginInPeriod && (
                            <TH align="right" style={{ width: pctW(COL_W.marginInPeriod) }}>
                              Est. margin — {selectedMonthLabel}
                            </TH>
                          )}
                        </>
                      )}
                      {columns.quantityToDate && (
                        <TH align="right" style={{ width: pctW(COL_W.quantityToDate) }}>
                          Qty to date
                        </TH>
                      )}
                      {contract.viewRates && columns.valueToDate && (
                        <TH align="right" style={{ width: pctW(COL_W.valueToDate) }}>
                          Value to date
                        </TH>
                      )}
                      {contract.viewRates && columns.costToDate && (
                        <TH align="right" style={{ width: pctW(COL_W.costToDate) }}>
                          Est. cost to date
                        </TH>
                      )}
                      {contract.viewRates && columns.marginToDate && (
                        <TH align="right" style={{ width: pctW(COL_W.marginToDate) }}>
                          Est. margin to date
                        </TH>
                      )}
                    </TR>
                  </THead>
                  <TBody>
                    {filteredRows.map((r) => (
                      <TR key={r.item.id}>
                        <TD className="align-top">
                          <ItemIdentity
                            item={r.item}
                            periodLabel={selectedMonthLabel}
                            onOpenPeriod={() => navigate(`/daily-entry?itemId=${r.item.id}&period=${selectedPeriod}`)}
                          />
                        </TD>
                        {columns.quantityInPeriod && (
                          <TD align="right" className="nc-numeric align-top">
                            {fmtQuantity(r.quantityInPeriod, r.item.unit)}
                          </TD>
                        )}
                        {contract.viewRates && (
                          <>
                            <TD align="right" className="nc-numeric align-top">
                              {rate(r.valueInPeriod)}
                            </TD>
                            {columns.costInPeriod && (
                              <TD align="right" className="nc-numeric align-top">
                                {rate(r.costInPeriod)}
                              </TD>
                            )}
                            {columns.marginInPeriod && (
                              <TD align="right" className={`nc-numeric align-top ${r.marginInPeriod !== null && r.marginInPeriod < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
                                {rate(r.marginInPeriod)}
                              </TD>
                            )}
                          </>
                        )}
                        {columns.quantityToDate && (
                          <TD align="right" className="nc-numeric align-top">
                            <button
                              type="button"
                              className="text-nc-info-text underline decoration-dotted hover:decoration-solid"
                              onClick={() => navigate(`/daily-entry?itemId=${r.item.id}`)}
                              title={`View ${r.item.itemNumber}'s confirmed records`}
                            >
                              {fmtQuantity(r.quantityToDate, r.item.unit)}
                            </button>
                          </TD>
                        )}
                        {contract.viewRates && columns.valueToDate && (
                          <TD align="right" className="nc-numeric align-top">
                            {rate(r.valueToDate)}
                          </TD>
                        )}
                        {contract.viewRates && columns.costToDate && (
                          <TD align="right" className="nc-numeric align-top">
                            {rate(r.costToDate)}
                          </TD>
                        )}
                        {contract.viewRates && columns.marginToDate && (
                          <TD align="right" className={`nc-numeric align-top ${r.marginToDate !== null && r.marginToDate < 0 ? 'font-semibold text-nc-danger-text' : ''}`}>
                            {rate(r.marginToDate)}
                          </TD>
                        )}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}

            {/* Totals as cards, not a footer row — the answer, not a
                footnote (same as Rates). Quantity has no card: mixed units
                across Items make a summed quantity meaningless, so it's
                left out entirely rather than shown blank with an
                explanation nobody expects to need. */}
            {contract.viewRates && filteredRows.length > 0 && (
              <div className={`mt-6 grid gap-4 ${columns.costInPeriod || columns.marginInPeriod || columns.costToDate || columns.marginToDate ? 'grid-cols-3' : 'grid-cols-2'}`}>
                <StatCard label={`Value — ${selectedMonthLabel}`} value={rate(monthTotals.value)} sub={<CoverageNote coverage={valueCoverage} />} />
                {columns.costInPeriod && <StatCard label={`Est. cost — ${selectedMonthLabel}`} value={rate(monthTotals.cost)} sub={<CoverageNote coverage={periodCostCoverage} />} />}
                {columns.marginInPeriod && (
                  <StatCard
                    label={`Est. margin — ${selectedMonthLabel}`}
                    value={<span className={monthTotals.margin !== null && monthTotals.margin < 0 ? 'text-nc-danger-text' : ''}>{rate(monthTotals.margin)}</span>}
                    sub={<CoverageNote coverage={periodMarginCoverage} />}
                  />
                )}
                {columns.valueToDate && <StatCard label="Value to date" value={rate(monthTotals.toDateValue)} sub={<CoverageNote coverage={valueCoverage} />} />}
                {columns.costToDate && <StatCard label="Est. cost to date" value={rate(monthTotals.toDateCost)} sub={<CoverageNote coverage={toDateCostCoverage} />} />}
                {columns.marginToDate && (
                  <StatCard
                    label="Est. margin to date"
                    value={<span className={monthTotals.toDateMargin !== null && monthTotals.toDateMargin < 0 ? 'text-nc-danger-text' : ''}>{rate(monthTotals.toDateMargin)}</span>}
                    sub={<CoverageNote coverage={toDateMarginCoverage} />}
                  />
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
