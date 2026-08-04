import { useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IconAlertTriangle, IconClockPause, IconFlag, IconMinus, IconTrendingDown, IconTrendingUp } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, type ItemPrice } from '../../lib/supabase/prices'
import { fetchContractMonths, fetchItemMonths, fetchItemProgressRate, type ContractMonth, type ItemMonth, type ItemProgressRate } from '../../lib/supabase/monthlyPeriods'
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
import { errorMessage } from '../../lib/errorMessage'
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
  const [pins, setPins] = useState<PinnedItem[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  // Pin picker + pin/unpin in-flight state — separate from the page's own
  // load/error state, since a failed pin shouldn't blank the whole screen
  // the way a failed initial fetch does.
  const [pinSelection, setPinSelection] = useState('')
  const [pinning, setPinning] = useState(false)
  const [unpinningId, setUnpinningId] = useState<string | null>(null)
  const [pinActionError, setPinActionError] = useState<string | null>(null)

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
      fetchPinnedItems(contract.id),
    ])
      .then(([itemRows, priceRows, contractMonthRows, itemMonthRows, progressRows, pinRows]) => {
        setItems(itemRows)
        setPrices(priceRows)
        setContractMonths(contractMonthRows)
        setItemMonths(itemMonthRows)
        setProgressRate(progressRows)
        setPins(pinRows)
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

  // Band 4 — month detail table.
  const availableMonths = useMemo(() => {
    const keys = new Set(itemMonths.map((m) => m.periodMonth))
    keys.add(monthKeyToPeriod(nowMonthKey))
    return [...keys].sort().reverse()
  }, [itemMonths, nowMonthKey])

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

              {/* Band 3 — money, for the CFO. Keyed to selectedMonth (see
                  above) — same period Band 4's dropdown shows, always. */}
              <section className="mb-8">
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Money — {formatMonthLabel(selectedMonth)}</h2>
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
