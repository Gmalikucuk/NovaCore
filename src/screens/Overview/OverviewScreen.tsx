import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom'
import { IconAlertTriangle, IconClockPause, IconFlag } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { fetchItems, type Item } from '../../lib/supabase/items'
import { fetchItemPrices, type ItemPrice } from '../../lib/supabase/prices'
import { fetchContractMonths, fetchItemMonths, fetchItemProgressRate, type ContractMonth, type ItemMonth, type ItemProgressRate } from '../../lib/supabase/monthlyPeriods'
import { fetchLastConfirmedAt } from '../../lib/supabase/quantityRecords'
import { fetchPinnedItems, pinItem, unpinItem, type PinnedItem } from '../../lib/supabase/pinnedItems'
import { BEHIND_RATE_THRESHOLD_DAYS, buildProblemList, formatMonthLabel, itemsInProgress, monthKeyFromDate, monthKeyToPeriod, type ProblemItem } from '../../lib/calculations/overview'
import { compareItemCodes } from '../../lib/calculations/naturalSort'
import { margin as computeMargin } from '../../lib/calculations/margin'
import { formatConfirmedAt } from '../../lib/dateFormat'
import { errorMessage } from '../../lib/errorMessage'
import { money, percent, quantity as fmtQuantity } from '../../lib/format'
import { Button, Card, EmptyState, NotificationBanner, PageHeader, SandboxBanner, Select, Spinner } from '../../components/ui'

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
  const [searchParams] = useSearchParams()

  const [items, setItems] = useState<Item[]>([])
  const [prices, setPrices] = useState<ItemPrice[]>([])
  const [contractMonths, setContractMonths] = useState<ContractMonth[]>([])
  const [itemMonths, setItemMonths] = useState<ItemMonth[]>([])
  const [progressRate, setProgressRate] = useState<ItemProgressRate[]>([])
  const [pins, setPins] = useState<PinnedItem[]>([])
  const [lastConfirmedAt, setLastConfirmedAt] = useState<string | null>(null)
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
  const [attentionExpanded, setAttentionExpanded] = useState(false)
  // "How far along are we" vs "what does that come to" — the split is by
  // question, not by role (the PM's own work already lives in Confirm/Daily
  // Entry, not here). One tab visible at a time, at every viewport size —
  // not a mobile-only collapse, an actual navigational split. Opens on
  // Finance when a month screen's "Back to Finance" link sends us here with
  // ?tab=finance, so returning from a month doesn't strand you on Progress.
  const [activeTab, setActiveTab] = useState<OverviewTab>(searchParams.get('tab') === 'finance' ? 'finance' : 'progress')

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
  // they watch (the Pinned Items band). itemsInProgress reads progressRate
  // directly (v_item_progress_rate, already unit_price-only) — this one's a
  // count, not a blend, and stays.
  const inProgress = useMemo(() => itemsInProgress(progressRate), [progressRate])

  // Band 2 — needs attention, worst-consequence-first (buildProblemList's
  // own ranking); capped here, not in the pure function, so "N more" can
  // report against the true total.
  const problemList = useMemo(() => buildProblemList(progressRate, new Date()), [progressRate])
  const visibleProblems = attentionExpanded ? problemList : problemList.slice(0, ATTENTION_CAP)
  const hiddenProblemCount = problemList.length - visibleProblems.length

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

  // Finance — a compact list of months, most recent first. The finance
  // manager's unit of thought is the monthly progress estimate (GC 52.01
  // puts one in the Ministry Representative's hands within seven days of
  // each month's start), not a wall of Items — that's the detail BEHIND a
  // month, which is what opening one now leads to (FinanceMonthScreen).
  //
  // Status is calendar-only, deliberately, and the word for a past month is
  // "Past" — not "Closed". Records are append-only: a correction confirmed
  // today against a July record supersedes its predecessor and changes
  // July's own figures (Hwy 97C's 05.03.03 is the live example — a
  // confirmed correction dropped it from 3,785 t to 3,699 t). "Closed"
  // reads as final to a finance manager; nothing here is. "Past" says only
  // what's true — the month has ended — and "In progress" says only that
  // the current one hasn't. Neither claims anything about Ministry
  // submission or approval; NovaCore holds no record of either.
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
          value: contractMonth?.valueInPeriod ?? null,
          margin: contractMonth?.marginInPeriod ?? null,
        }
      })
  }, [itemMonths, contractMonths, nowMonthKey])

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
              {/* Pinned Items — a progress instrument for the PM team and
                  the owner (also on OwnerScreen), not a finance one. Off the
                  Finance tab entirely now; it isn't behind the question
                  "what did we earn and can I defend it." */}
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
                    action={
                      unitPriceItems.length > 0 ? <PinPicker items={pinnableItems} value={pinSelection} onChange={setPinSelection} onPin={() => void handlePin()} pinning={pinning} /> : undefined
                    }
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

              {/* A compact list of months — one row each, nothing else on
                  the row. A month opens to its own screen (Item detail,
                  drill-down, export) — that's the detail behind a month,
                  not a summary of it. */}
              <section>
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-nc-text-muted">Months</h2>
                  <p className="text-xs text-nc-text-muted">{lastConfirmedAt ? <>Confirmed records as of {formatConfirmedAt(lastConfirmedAt)}</> : 'No confirmed records yet'}</p>
                </div>
                <div className="flex flex-col divide-y divide-nc-border rounded-lg border border-nc-border bg-white shadow-sm">
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
                          <div className="text-right">
                            <div className="text-xs text-nc-text-muted">Value</div>
                            <div className="nc-numeric text-sm font-semibold text-nc-text">{money(fm.value)}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-nc-text-muted">Margin</div>
                            <div className={`nc-numeric text-sm font-semibold ${fm.margin !== null && fm.margin < 0 ? 'text-nc-danger-text' : 'text-nc-text'}`}>{money(fm.margin)}</div>
                          </div>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  )
}
