import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { IconAlertTriangle, IconClockPause, IconFlag, IconMinus, IconTrendingDown, IconTrendingUp } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, type ItemPrice } from '../../lib/supabase/prices'
import { fetchContractMonths, fetchItemMonths, fetchItemProgressRate, type ContractMonth, type ItemMonth, type ItemProgressRate } from '../../lib/supabase/monthlyPeriods'
import { fetchLastConfirmedAt } from '../../lib/supabase/quantityRecords'
import { fetchPinnedItems, pinItem, unpinItem, type PinnedItem } from '../../lib/supabase/pinnedItems'
import {
  BEHIND_RATE_THRESHOLD_DAYS,
  buildProblemList,
  formatMonthLabel,
  itemsInProgress,
  monthDirection,
  monthKeyFromDate,
  monthKeyToPeriod,
  previousMonth,
  type Direction,
  type MonthKey,
  type ProblemItem,
} from '../../lib/calculations/overview'
import { compareItemCodes } from '../../lib/calculations/naturalSort'
import { margin as computeMargin, sumOrNull } from '../../lib/calculations/margin'
import { formatConfirmedAt } from '../../lib/dateFormat'
import { errorMessage } from '../../lib/errorMessage'
import { exportFinanceWorkbook, type FinanceExportRow } from '../../lib/export/financeExport'
import { money, percent, quantity as fmtQuantity } from '../../lib/format'
import { Button, Card, EmptyState, NotificationBanner, PageHeader, SandboxBanner, Select, Spinner, StatCard, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

const ATTENTION_CAP = 5

/**
 * Picking an Item to pin is one obvious action: choose from a list, click
 * Pin. Shared between the empty state (where it doubles as the "what do I
 * do" affordance) and the ordinary picker under an existing pinned list.
 */
function PinPicker({
  items,
  value,
  onChange,
  onPin,
  pinning,
}: {
  items: readonly { id: string; itemNumber: string; description: string }[]
  value: string
  onChange: (id: string) => void
  onPin: () => void
  pinning: boolean
}) {
  return (
    <div className="flex flex-wrap items-end justify-center gap-2">
      <div className="w-72 text-left">
        <label className="mb-1 block text-xs text-nc-text-muted" htmlFor="pin-item-select">
          Pin an Item
        </label>
        <Select id="pin-item-select" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose an Item…</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.itemNumber} — {i.description}
            </option>
          ))}
        </Select>
      </div>
      <Button type="button" disabled={!value || pinning} onClick={onPin}>
        {pinning ? 'Pinning…' : 'Pin'}
      </Button>
    </div>
  )
}

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

type OverviewTab = 'progress' | 'finance'

export function OverviewScreen() {
  const contract = useOutletContext<MyContract>()
  const navigate = useNavigate()

  const [items, setItems] = useState<Item[]>([])
  const [prices, setPrices] = useState<ItemPrice[]>([])
  const [contractMonths, setContractMonths] = useState<ContractMonth[]>([])
  const [itemMonths, setItemMonths] = useState<ItemMonth[]>([])
  const [progressRate, setProgressRate] = useState<ItemProgressRate[]>([])
  const [pins, setPins] = useState<PinnedItem[]>([])
  const [lastConfirmedAt, setLastConfirmedAt] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  // Pin picker + pin/unpin in-flight state — separate from the page's own
  // load/error state, since a failed pin shouldn't blank the whole screen
  // the way a failed initial fetch does.
  const [pinSelection, setPinSelection] = useState('')
  const [pinning, setPinning] = useState(false)
  const [unpinningId, setUnpinningId] = useState<string | null>(null)
  const [pinActionError, setPinActionError] = useState<string | null>(null)

  const nowMonthKey = useMemo(() => monthKeyFromDate(new Date()), [])
  const [selectedMonth, setSelectedMonth] = useState<MonthKey>(nowMonthKey)
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
      fetchPinnedItems(contract.id),
      // Not gated on viewRates — this is a fact about the records
      // (quantity_records has no finance-wall gate; membership alone grants
      // visibility of quantities, same as everywhere else in this schema),
      // and is only ever displayed alongside the money it explains.
      fetchLastConfirmedAt(contract.id),
    ])
      .then(([itemRows, priceRows, contractMonthRows, itemMonthRows, progressRows, pinRows, lastConfirmed]) => {
        setItems(itemRows)
        setPrices(priceRows)
        setContractMonths(contractMonthRows)
        setItemMonths(itemMonthRows)
        setProgressRate(progressRows)
        setPins(pinRows)
        setLastConfirmedAt(lastConfirmed)
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

  // Band 1 — progress. The "Contract complete" quantity-weighted blend that
  // used to live here is gone (0015) — it weighted Mobilization and sign
  // installation the same as paving, and a blended figure across every Unit
  // Price Item measures nothing anyone acts on. Not replaced with a
  // different weighting; replaced with letting the person pick which Items
  // they watch (the Pinned Items band, above the tabs). itemsInProgress
  // reads progressRate directly (v_item_progress_rate, already
  // unit_price-only) — this one's a count, not a blend, and stays.
  const inProgress = useMemo(() => itemsInProgress(progressRate), [progressRate])

  // Band 2 — needs attention, worst-consequence-first (buildProblemList's
  // own ranking); capped here, not in the pure function, so "N more" can
  // report against the true total.
  const problemList = useMemo(() => buildProblemList(progressRate, new Date()), [progressRate])
  const visibleProblems = attentionExpanded ? problemList : problemList.slice(0, ATTENTION_CAP)
  const hiddenProblemCount = problemList.length - visibleProblems.length

  const selectedPeriod = monthKeyToPeriod(selectedMonth)

  // Band 3 — money. Keyed to Band 4's selectedMonth, same period the table
  // below is showing — these used to read the actual current calendar month
  // regardless of what was selected, which meant the "No records yet for
  // <month>" text here could name a different month than the one the
  // dropdown below was actually showing. Fixed so both always agree.
  const currentContractMonth = contractMonths.find((m) => m.periodMonth === selectedPeriod)
  const previousContractMonth = contractMonths.find((m) => m.periodMonth === monthKeyToPeriod(previousMonth(selectedMonth)))
  const valueThisMonth = currentContractMonth?.valueInPeriod ?? 0
  const valueLastMonth = previousContractMonth?.valueInPeriod ?? 0
  const marginThisMonth = currentContractMonth?.marginInPeriod ?? 0
  const marginLastMonth = previousContractMonth?.marginInPeriod ?? 0

  // Band 4 — Item detail. The billing-industry vocabulary a finance manager
  // already thinks in: this period, previous period, to date, remaining.
  // No % complete, no weighting — Remaining is a plain Approximate Quantity
  // minus quantity to date, same arithmetic the brief calls for and nothing
  // more invented than that.
  const previousSelectedMonth = useMemo(() => previousMonth(selectedMonth), [selectedMonth])
  const previousSelectedPeriod = monthKeyToPeriod(previousSelectedMonth)

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

  // Pinned Items — only Unit Price Items are pinnable (isUnitPriceItem's
  // reasoning: neither a Lump Sum nor a Provisional Sum Item has a
  // quantity-against-Approximate-Quantity reading), enforced again here as
  // the picker's own filter, not just at the RLS insert policy.
  const pinnedItemIds = useMemo(() => new Set(pins.map((p) => p.itemId)), [pins])
  const pinnableItems = useMemo(
    () =>
      unitPriceItems
        .filter((i) => !pinnedItemIds.has(i.id))
        .slice()
        .sort((a, b) => compareItemCodes(a.itemNumber, b.itemNumber)),
    [unitPriceItems, pinnedItemIds],
  )
  const pinnedRows = useMemo(
    () =>
      pins
        .map((pin) => ({ pin, progress: progressByItem.get(pin.itemId) }))
        // A pin whose Item hasn't loaded into progressRate yet (or was
        // removed) has nothing to render — skip it rather than showing a
        // blank row; the FK's own cascade delete keeps this rare.
        .filter((row): row is { pin: PinnedItem; progress: ItemProgressRate } => row.progress !== undefined)
        .map((row) => ({
          ...row,
          margin: contract.viewRates ? computeMargin(row.progress.quantityToDate, costByItem.get(row.pin.itemId) ?? null, priceByItem.get(row.pin.itemId)?.unitPrice ?? null) : null,
        })),
    [pins, progressByItem, costByItem, priceByItem, contract.viewRates],
  )

  async function handlePin() {
    if (!pinSelection) return
    setPinning(true)
    setPinActionError(null)
    try {
      const pin = await pinItem(contract.id, pinSelection)
      setPins((prev) => [...prev, pin])
      setPinSelection('')
    } catch (err) {
      setPinActionError(errorMessage(err))
    } finally {
      setPinning(false)
    }
  }

  async function handleUnpin(pinId: string) {
    setUnpinningId(pinId)
    setPinActionError(null)
    try {
      await unpinItem(pinId)
      setPins((prev) => prev.filter((p) => p.id !== pinId))
    } catch (err) {
      setPinActionError(errorMessage(err))
    } finally {
      setUnpinningId(null)
    }
  }

  return (
    <div>
      <PageHeader title="Overview" subtitle={contract.name} />
      <p className="mb-6 max-w-3xl text-xs text-nc-text-subtle">
        Value of Work is recorded quantity × tendered Unit Price — the Contractor's own measure, not a Ministry-approved progress estimate.
      </p>

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
          {/* Pinned Items — above the tabs, deliberately: this is the
              person's own chosen watch-list, not a "how far along" or "what
              does that come to" question, so it isn't scoped to either tab.
              Also the top-of-page mobile-visibility target (see the
              verification note in the plan this shipped against): nothing
              heavier belongs above it. */}
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Pinned Items</h2>

            {pinActionError && (
              <NotificationBanner tone="danger" className="mb-3">
                {pinActionError}
              </NotificationBanner>
            )}

            {pinnedRows.length === 0 ? (
              <EmptyState
                title="Nothing pinned yet"
                description={
                  unitPriceItems.length === 0
                    ? "This contract has no Unit Price Items — Lump Sum and Provisional Sum Items don't have a quantity-against-Approximate-Quantity reading, so there's nothing here to pin."
                    : 'Pin the Items where the money actually is — quantity against Approximate Quantity, and margin to date if you hold view_rates. Only Unit Price Items are pinnable; everything else stays out of the way until you ask for it.'
                }
                action={unitPriceItems.length > 0 ? <PinPicker items={pinnableItems} value={pinSelection} onChange={setPinSelection} onPin={() => void handlePin()} pinning={pinning} /> : undefined}
              />
            ) : (
              <>
                <div className="flex flex-col divide-y divide-nc-border rounded-lg border border-nc-border bg-white shadow-sm">
                  {pinnedRows.map(({ pin, progress, margin: pinMargin }) => (
                    <div key={pin.id} className="flex items-start justify-between gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          <span className="nc-numeric font-semibold text-nc-text">{progress.itemNumber}</span> <span className="text-nc-text-muted">{progress.description}</span>
                        </p>
                        <p className="nc-numeric text-sm text-nc-text">
                          {fmtQuantity(progress.quantityToDate)} of {fmtQuantity(progress.approximateQuantity, progress.unit)} — {percent(progress.proportionComplete)}
                        </p>
                        {contract.viewRates && (
                          <p className="text-sm text-nc-text-muted">
                            Margin to date: <span className="nc-numeric">{money(pinMargin)}</span>
                          </p>
                        )}
                      </div>
                      <Button type="button" variant="ghost" disabled={unpinningId === pin.id} onClick={() => void handleUnpin(pin.id)}>
                        {unpinningId === pin.id ? 'Unpinning…' : 'Unpin'}
                      </Button>
                    </div>
                  ))}
                </div>
                {pinnableItems.length > 0 && (
                  <div className="mt-3">
                    <PinPicker items={pinnableItems} value={pinSelection} onChange={setPinSelection} onPin={() => void handlePin()} pinning={pinning} />
                  </div>
                )}
              </>
            )}
          </section>

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
              {/* Band 1 — progress. "Contract complete" (a quantity-weighted
                  blend across every Unit Price Item) used to live here; removed
                  in favour of Pinned Items above, which is the same
                  information at a level someone can actually act on. */}
              <div className="mb-8 max-w-xs">
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

              {/* Band 3 — money, for the finance manager. Keyed to
                  selectedMonth (see above) — same period Band 4's table
                  shows, always. The freshness line is the answer to "as of
                  when" — not a page-load timestamp, the actual moment the
                  records behind these figures were confirmed. */}
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

              {/* Band 4 — Item detail. The vocabulary this table now uses —
                  this period, previous period, to date, remaining — is the
                  one the unit-price billing industry already uses; no
                  toggle between a "period" view and a "to date" view any
                  more, because the answer to "what did we earn" and the
                  answer to "can I defend it" are never in two different
                  places. Not reachable single-column, so hidden entirely
                  below sm: rather than squeezed. */}
              <section className="hidden sm:block">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-4">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Item detail</h2>
                  <div className="flex items-center gap-3">
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
        </>
      )}
    </div>
  )
}
